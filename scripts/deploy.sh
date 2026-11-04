#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_ARN="${1:-}"
PROFILE="${AWS_PROFILE:-yuta}"
REGION="${AWS_REGION:-ap-northeast-1}"

if [[ -z "$IMAGE_ARN" ]]; then
  echo "Usage: AWS_PROFILE=yuta $0 <microvm-image-arn>" >&2
  exit 2
fi
if [[ ! "$IMAGE_ARN" =~ ^arn:aws(-[a-z]+)?:lambda:${REGION}:[0-9]{12}:microvm-image:.+$ ]]; then
  echo "Image ARN must belong to region ${REGION}." >&2
  exit 2
fi

for command in aws terraform node npm curl; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"
aws sts get-caller-identity >/dev/null

echo "Installing pinned control-plane dependencies..."
npm ci --prefix "$ROOT/control" --omit=dev --ignore-scripts --no-audit --no-fund

echo "Building the static Slidev deck..."
npm ci --prefix "$ROOT/slides" --no-audit --no-fund
npm --prefix "$ROOT/slides" run build

mkdir -p "$ROOT/infra/build"
ROOT="$ROOT" IMAGE_ARN="$IMAGE_ARN" REGION="$REGION" node --input-type=module -e '
import { writeFile } from "node:fs/promises";
const imageArn = process.env.IMAGE_ARN;
const region = process.env.REGION;
await writeFile(`${process.env.ROOT}/infra/workshop.auto.tfvars.json`, JSON.stringify({
  deploy_workshop: true,
  microvm_image_arn: imageArn,
  aws_region: region,
}, null, 2) + "\n", { mode: 0o600 });
'
chmod 600 "$ROOT/infra/workshop.auto.tfvars.json"

terraform -chdir="$ROOT/infra" init
ROOT="$ROOT" node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = process.env.ROOT;
const addresses = execFileSync("terraform", [`-chdir=${root}/infra`, "state", "list"], { encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean);
const staleAssets = addresses.filter(address => {
  const match = address.match(/^aws_s3_object\.site\["(.+)"\]$/);
  return match?.[1].startsWith("assets/") && !existsSync(resolve(root, "slides/dist", match[1]));
});
if (staleAssets.length) {
  console.log(`Retaining ${staleAssets.length} old content-hashed assets for browsers with cached pages.`);
  execFileSync("terraform", [`-chdir=${root}/infra`, "state", "rm", ...staleAssets], { stdio: "inherit" });
}
'
terraform -chdir="$ROOT/infra" apply -var-file=workshop.auto.tfvars.json -auto-approve

WORKSHOP_URL="$(terraform -chdir="$ROOT/infra" output -raw workshop_url)"
echo "Checking deployed health endpoint: ${WORKSHOP_URL}/api/health"
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error "${WORKSHOP_URL}/api/health"; then
    printf '\nWorkshop URL: %s\n' "$WORKSHOP_URL"
    exit 0
  fi
  sleep 10
done

echo "The stack deployed, but its public health endpoint did not become ready within 10 minutes: ${WORKSHOP_URL}" >&2
exit 1
