#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${AWS_PROFILE:-yuta}"
REGION="${AWS_REGION:-ap-northeast-1}"
IMAGE_NAME="${IMAGE_NAME:-floci-workshop-$(date -u +%Y%m%d%H%M%S)}"
BUILD_LOG_GROUP="$(terraform -chdir="$ROOT/infra" output -raw microvm_build_log_group)"

for command in aws terraform zip; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

ARTIFACT_BUCKET="$(terraform -chdir="$ROOT/infra" output -raw microvm_artifact_bucket)"
BUILD_ROLE_ARN="$(terraform -chdir="$ROOT/infra" output -raw microvm_build_role_arn)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/floci-image.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir "$TMP/payload"
cp "$ROOT/microvm/Dockerfile" \
  "$ROOT/microvm/package.json" \
  "$ROOT/microvm/package-lock.json" \
  "$ROOT/microvm/server.mjs" \
  "$ROOT/microvm/vitest.config.ts" \
  "$TMP/payload/"
cp -R "$ROOT/microvm/lib" "$ROOT/microvm/src" "$ROOT/microvm/tests" "$TMP/payload/"
(cd "$TMP/payload" && zip -qr "$TMP/microvm.zip" .)
KEY="microvm/${IMAGE_NAME}.zip"
aws --profile "$PROFILE" --region "$REGION" s3 cp "$TMP/microvm.zip" "s3://${ARTIFACT_BUCKET}/${KEY}" --sse AES256

HOOKS="$TMP/hooks.json"
cat > "$HOOKS" <<'JSON'
{
  "port": 8080,
  "microvmHooks": {
    "run": "ENABLED",
    "runTimeoutInSeconds": 60,
    "resume": "ENABLED",
    "resumeTimeoutInSeconds": 60
  },
  "microvmImageHooks": {
    "ready": "ENABLED",
    "readyTimeoutInSeconds": 600,
    "validate": "ENABLED",
    "validateTimeoutInSeconds": 600
  }
}
JSON

LOGGING="$TMP/logging.json"
cat > "$LOGGING" <<JSON
{
  "cloudWatch": {
    "logGroup": "${BUILD_LOG_GROUP}",
    "logStream": "${IMAGE_NAME}"
  }
}
JSON

IMAGE_ARN="$(aws --profile "$PROFILE" --region "$REGION" lambda-microvms create-microvm-image \
  --name "$IMAGE_NAME" \
  --description "Floci invoice batch import workshop: S3, SQS, DynamoDB, SNS" \
  --code-artifact "uri=s3://${ARTIFACT_BUCKET}/${KEY}" \
  --base-image-arn "arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1" \
  --build-role-arn "$BUILD_ROLE_ARN" \
  --cpu-configurations '[{"architecture":"ARM_64"}]' \
  --resources '[{"minimumMemoryInMiB":512}]' \
  --hooks "file://${HOOKS}" \
  --logging "file://${LOGGING}" \
  --query imageArn --output text)"

echo "Waiting for MicroVM image build: $IMAGE_ARN"
for attempt in $(seq 1 180); do
  STATE="$(aws --profile "$PROFILE" --region "$REGION" lambda-microvms get-microvm-image \
    --image-identifier "$IMAGE_ARN" --query state --output text 2>/dev/null || true)"
  case "$STATE" in
    CREATED)
      echo "MicroVM image is ready: $IMAGE_ARN"
      exit 0
      ;;
    CREATE_FAILED|DELETING|DELETED)
      echo "MicroVM image build ended in state: $STATE" >&2
      exit 1
      ;;
  esac
  sleep 10
done

echo "Timed out waiting for image creation. Check its status and CloudWatch build logs: $IMAGE_ARN" >&2
exit 1
