# Floci Workshop

20-minute hands-on for JAWS-UG Nagoya: start from the local-test workflow, explain Floci, show the AWS invoice-import path, then write an integration test for duplicate SQS delivery and a follow-up test for an invoice overwrite.

The full requirements and acceptance criteria are in [`spec.md`](spec.md). The public workshop stack is meant to be deployed for the event and removed afterward.

## Architecture

```text
Browser: Slidev + persistent Monaco editor + xterm.js
   ├── HTTPS same-origin API → API Gateway → Lambda control plane → DynamoDB session table
   └── WSS + short-lived, port-scoped token → attendee MicroVM :8081
                                                ├── real interactive Bash PTY
                                                ├── Vitest
                                                └── one local AWS backend at a time:
                                                    Floci or AWS Emulator
                                                    S3 → SQS → batch worker → DynamoDB → SNS
                                                                      └── SQS DLQ for repeated failures
```

The target system imports supplier invoice CSVs in batches. S3 object-created notifications enqueue import jobs; the worker polls up to 10 jobs, validates rows, writes valid invoices to DynamoDB in batches of at most 25, and publishes a per-file summary through SNS. Invalid rows appear in the summary. Transient failures leave messages for SQS retry and eventual DLQ investigation. The advanced exercise discovers an unresolved duplicate-invoice overwrite bug.

The workbench remains hidden during the introduction and appears when participants are asked to write the test. From then on it uses the bottom 70% of the slide: Monaco on the left and a normal interactive Bash session on the right. xterm.js displays a real Bash process attached to a PTY with readline, terminal resizing, signals, and job control; commands run in the participant's MicroVM rather than through a command simulator. One Bash process and its working directory stay alive while the participant moves between slides.

The Slidev deck follows the supplied `mu7889yoon` Marp theme: light grid, circular accents, grayscale typography, and matching code blocks. The standalone Marp talk deck and theme CSS are in [`marp/`](marp/); its PDF handout is in [`output/pdf/floci-workshop.pdf`](output/pdf/floci-workshop.pdf).

The editor syncs both exercise files to the attendee VM as they change. Shell-side edits are watched and reflected back into Monaco. The control API mints a five-minute Lambda MicroVM auth token scoped only to terminal port 8081; the browser uses it for the WebSocket connection. It receives no AWS credentials or MicroVM ID. Each VM has no internet egress connector or AWS execution role. A scheduled cleanup function terminates expired VMs.

The duplicate-delivery exercise puts the same S3 event body into the SQS queue twice, then checks the number of SNS summaries. Participants replace a TODO with `expect(summaries).toHaveLength(1)`; the current worker sends two summaries, so the test exposes the duplicate side effect. This controlled fixture makes the behavior repeatable; it does not claim to reproduce every timing detail of AWS SQS redelivery.

The attendee MicroVM includes a pinned ARM64 build of the official AWS Emulator alongside Floci. `microvm/config/aws-endpoint.json` selects the local endpoint: `http://127.0.0.1:4566` for Floci or `https://127.0.0.1:9297` for AWS Emulator. The next health check or test run stops the current backend and starts the selected one, so they never compete for the 512-MiB VM. The test launcher configures AWS Emulator's generated credentials and TLS certificate, clears AWS profile credentials, and disables its telemetry for the workshop image. Switching back stops AWS Emulator and clears its in-memory resources.

AWS Emulator support is evolving quickly. Its fidelity varies by service and API, and it does not evaluate IAM policies. This hands-on uses it to compare the same AWS SDK integration path; it does not replace security, quota, or production checks in AWS. Review the current [AWS Emulator fidelity guide](https://docs.aws.amazon.com/emulator/latest/userguide/fidelity.html) before the event.

## Prerequisites

- AWS CLI v2 with the Lambda MicroVM command group and profile `yuta`, Terraform 1.9+, Node.js 24+, npm, `zip`, and network access to npm and Docker Hub.
- `ap-northeast-1` enabled for Lambda MicroVMs and sufficient MicroVM concurrency/TPS quota.
- Permission to create the Terraform resources and `iam:PassRole` for the MicroVM image build role.

## Deploy

### 1. Bootstrap the MicroVM image build bucket and role

```bash
cd infra
terraform init
AWS_PROFILE=yuta terraform apply -var='deploy_workshop=false'
cd ..
```

The bootstrap creates the private S3 artifact bucket and image build role. It does not publish the site or create participant VMs.

### 2. Build and register the MicroVM image

```bash
AWS_PROFILE=yuta ./scripts/create-microvm-image.sh
```

The script packages the MicroVM app, uploads the ZIP to the Terraform-managed bucket, creates a Lambda MicroVM image, waits for `CREATED`, and prints its ARN. Image creation is an AWS API operation; Terraform manages its prerequisites, while AWS manages the image build lifecycle.

### 3. Deploy the site

```bash
AWS_PROFILE=yuta ./scripts/deploy.sh 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:floci-workshop-v1'
```

Deployment builds the Slidev site and Lambda package, then applies S3, CloudFront, API Gateway, Lambda, DynamoDB, IAM, and scheduled cleanup resources. During the event, participants can start their own MicroVM from the public workshop page without entering a code. Provision the stack only for the event and destroy it afterward.

Terraform outputs the HTTPS CloudFront URL. Verify its health endpoint:

```bash
curl -i "$(cd infra && terraform output -raw workshop_url)/api/health"
```

Then open the URL and click **参加して環境を起動** on the session slide. On the following exercise slide, the Bash pane connects to the participant's MicroVM. Try `pwd`, then `npm run test:idempotency` or `npm run test:advanced`. The MicroVM image's `/validate` hook runs fixed Floci integration smoke tests before AWS accepts the image.

## Teardown

After the event, first wait for the scheduled reaper or confirm no workshop MicroVMs remain. Then run:

```bash
cd infra
AWS_PROFILE=yuta terraform destroy -var='deploy_workshop=true' -var='microvm_image_arn=YOUR_IMAGE_ARN'
```

The MicroVM image is a separate AWS resource and should be deleted with the matching `delete-microvm-image` API after all VMs are terminated.

## Costs and limits

CloudFront, Lambda, API Gateway, DynamoDB, CloudWatch Logs, S3, and each running MicroVM can incur charges. Configure `max_sessions` to the room size, terminate VMs promptly, and remove the stack after the event. Lambda MicroVM launch APIs have account/region rate limits; request a quota increase before a large concurrent workshop.

## Verification

```bash
./scripts/verify.sh
node --check control/handler.mjs
node --check control/reaper.mjs
node --check microvm/server.mjs
```

Local checks do not prove AWS IAM, network, quota, or endpoint behavior. The deployment should also be opened in a browser, joined, and checked with the real MicroVM Bash before the event.
