# Terraform deployment

Terraform owns the static hosting, control plane, session storage, IAM roles, and cleanup schedule. It also provisions the private MicroVM build artifact bucket and build role. AWS owns the asynchronous MicroVM image build itself; that is started by `scripts/create-microvm-image.sh`, then its ARN is passed into Terraform.

## Why this layout

- App Runner is not used. AWS closed it to new customers on March 31, 2026.
- Slidev is static content in a private S3 bucket behind CloudFront Origin Access Control.
- CloudFront routes `/api/*` to API Gateway and Lambda. The Lambda is stateless; DynamoDB stores attendee sessions and an atomic active-session counter.
- CloudFront injects an origin-only header to prevent direct API Gateway calls from bypassing the intended site path. API responses are not cached.
- A scheduled Lambda reaper terminates expired VMs and releases session slots.

## Commands

```bash
cd infra
terraform init
AWS_PROFILE=yuta terraform apply -var='deploy_workshop=false'
cd ..
AWS_PROFILE=yuta ./scripts/create-microvm-image.sh
AWS_PROFILE=yuta ./scripts/deploy.sh 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:floci-workshop-v1'
```

The bootstrap phase creates the build bucket and role. `create-microvm-image.sh` creates a versioned image using the pinned Floci release and the minimum 512-MiB ARM64 baseline (0.25 vCPU). `deploy.sh` writes deployment inputs to `workshop.auto.tfvars.json`, builds Slidev and Lambda packages, uploads static assets, and applies the public site and API. The auto tfvars file is ignored by Git so a later plain `terraform plan` retains `deploy_workshop=true`.

The workshop page is public while deployed. Participants start a VM by clicking the join button; deploy the stack only during the event and tear it down afterward.

## Inputs

| Variable | Default | Meaning |
| --- | --- | --- |
| `aws_region` | `ap-northeast-1` | Region for API, MicroVMs, S3, and DynamoDB |
| `name` | `floci-workshop` | Resource name prefix |
| `max_sessions` | `30` | Atomic cap on simultaneously allocated participant VMs |
| `session_ttl_seconds` | `3600` | Session and MicroVM maximum duration |
| `deploy_workshop` | `false` | Bootstrap gate; `true` after creating the MicroVM image |
| `microvm_image_arn` | empty | Required when `deploy_workshop=true` |

## Cost and lifecycle

The site, CloudFront, API Gateway, Lambda, DynamoDB, logs, and each active MicroVM can incur charges. The reaper runs every two minutes. The configured VM maximum duration is one hour. After the workshop, wait for cleanup, terminate any remaining VMs, then destroy the stack using its persisted auto tfvars:

```bash
cd infra
AWS_PROFILE=yuta terraform destroy -var-file=workshop.auto.tfvars.json
```

The MicroVM image is not Terraform-managed in this implementation. Delete it after all VMs are terminated with `aws lambda-microvms delete-microvm-image --image-identifier IMAGE_ARN --profile yuta --region ap-northeast-1`. The bootstrap artifact bucket is force-destroyed by Terraform.

## Known operational boundary

The session slot counter and reservation are one DynamoDB transaction. The MicroVM API call is necessarily a separate AWS transaction. A retry-safe `clientToken` based on the attendee session ID lets a repeated join recover a VM if the control Lambda is interrupted after reservation. The reaper handles persisted VM IDs and empty reservations. AWS deployment must still be tested for the account's actual quotas, IAM conditions, CloudFront propagation, and Floci compatibility.
