# Floci Workshop Specification

## Outcome

In 20 minutes, participants learn where AWS SDK mocks stop helping, what Floci emulates locally, and how to use it to find serverless batch-import bugs caused by duplicate delivery and repeated invoice IDs.

## Agenda

| Time | Segment | Participant outcome |
| --- | --- | --- |
| 0–7 min | Introduction | Compare local test approaches, understand Floci, and follow the S3 → SQS → batch worker → DynamoDB → SNS path. |
| 7–14 min | Duplicate-delivery exercise | Write an integration assertion for one summary per event and see that duplicate delivery currently produces two. |
| 14–20 min | Advanced exercise | Complete an assertion that detects a later CSV overwriting an existing invoice amount. |

## System behavior

- Introductory slides appear first without a workbench. When the speaker tells participants to write the Floci test, the screen changes to a compact instruction area above a persistent workbench that uses the lower 70% of the screen: Monaco editor and a real Bash terminal side by side.
- The editor holds two independent files, `tests/idempotency.spec.ts` and `tests/advanced.spec.ts`. Code, editor view state, Bash process, terminal history, current directory, and filesystem remain available while participants navigate between slides. Code is also retained in the browser tab and the VM.
- A same-origin HTTPS API starts an attendee session and issues an HttpOnly session cookie without requiring a venue code. The workshop site is public while deployed, so provision the stack only during the event.
- The control plane creates one AWS Lambda MicroVM per attendee. A DynamoDB table stores session-to-MicroVM mappings. A scheduled reaper terminates expired or abandoned VMs and releases the concurrent-session slot.
- Each MicroVM runs a Node HTTP API, an interactive Bash PTY, Vitest, and Floci 2.4.0 with S3, SQS, DynamoDB, and SNS enabled. Floci binds to loopback.
- A session-authenticated `/api/sync` route synchronizes the two editor files. `/api/terminal-token` returns the VM endpoint and a five-minute token restricted to port 8081. The browser connects directly to that port using the Lambda MicroVM WebSocket subprotocols. It receives no AWS credentials or MicroVM identifier.
- Bash uses `node-pty` and runs inside the attendee's own MicroVM. The shell is interactive and supports normal Bash input, resize, interrupt, and job control. The MicroVM has no internet egress connector or AWS execution role.
- Test setup creates an S3 input bucket with `ObjectCreated:*` → SQS notification, an import queue with a three-receive redrive policy and DLQ, an invoice table, and an SNS summary topic subscribed to an SQS test queue.
- The worker receives up to 10 import messages per poll, downloads the referenced CSV, parses quoted fields, validates rows independently, and writes valid invoices using DynamoDB `BatchWriteItem` chunks of at most 25. Unprocessed writes are retried with bounded exponential backoff.
- Malformed rows appear in the SNS summary without failing the whole file. A processing or notification failure leaves the SQS message for retry; after three receives SQS moves it to the DLQ. Successful messages are acknowledged after persistence and summary publication.
- The duplicate-delivery test harness places the same S3 event body into the Floci SQS queue twice, then runs the production worker and counts SNS summaries. The starter has a TODO and a throw. Replacing those lines with `expect(summaries).toHaveLength(1)` produces a reproducible failure because the current worker publishes two summaries. This controlled fixture tests duplicate effects; it does not reproduce every detail of AWS's internal redelivery timing.
- The advanced test uploads two files containing the same invoice ID but different amounts. The current unconditional batch write stores the later amount. Replacing the TODO and throw with `expect(saved?.amountCents).toBe(1200)` reports `Expected 1200 / Received 9999`.
- `POST /api/reset` restores both exercise files and restarts the Bash process. `POST /api/leave` terminates the attendee VM.

## Acceptance criteria

1. Two browser sessions receive different MicroVM IDs and cannot use each other's session cookies or terminal token.
2. The editor and Bash are hidden during the introduction and first appear when participants are asked to write the test.
3. The duplicate-delivery test starts at the TODO, then fails with two SNS summaries after replacing it with `expect(summaries).toHaveLength(1)`.
4. The Floci integration path creates S3/SQS/DynamoDB/SNS resources, consumes a batch of messages, stores valid invoices, reports malformed rows, publishes summaries, and moves repeatedly failing work to the DLQ.
5. The advanced test reports `Expected 1200 / Received 9999` after completing its assertion.
6. Bash input and output connect to only the attendee's own MicroVM. Its working directory and process survive slide navigation; shell-side edits to either exercise file are reflected in the editor.
7. The browser receives only a short-lived auth token scoped to terminal port 8081; the control plane retains AWS credentials and MicroVM IDs.
8. A participant can leave; expired sessions are cleaned up by the scheduled reaper.
9. The HTTPS site and API share one CloudFront origin, and API responses are not cached.

## Deployment boundary

Terraform provisions the artifact bucket/build role, static hosting, control plane, sessions, and cleanup schedule. The Lambda MicroVM image is created with the `lambda-microvms create-microvm-image` API after Terraform bootstraps its build bucket and role; its ARN is then supplied to the second Terraform apply.

The MicroVM image validation hook runs fixed S3/SQS/DynamoDB/SNS integration smoke tests before AWS accepts the image. This confirms the configured Floci service path but does not prove AWS event timing, IAM policy behavior, endpoint networking, or production quotas.
