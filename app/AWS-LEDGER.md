# AWS resource ledger — Mayfly control plane

**Account:** 163703054402 (`user/mike.ng`) · **Region:** ap-northeast-1 (Tokyo)

> Live record of everything created **directly in AWS** for the control plane, so teardown never
> needs CloudTrail archaeology. Everything is CDK-managed (`app/infra`) — no manual resource creation.

## Current state — DEPLOYED 2026-07-11 (Phase 6 live)

Control plane + demo API deployed to Tokyo (spend authorized). GitHub App not yet created.

| # | When | Resource | Created by | Cost | How to destroy |
|---|------|----------|-----------|------|----------------|
| 1 | 2026-07-11 | **MayflyStack** (DynamoDB+GSI, SQS+DLQ, 3 Lambdas, Function URL, SNS+3 alarms, S3 ArtifactBucket, MicrovmBuildRole, EventBridge rule) | `cd app/infra && npm run deploy` | ~$0 idle + ~$0.40/mo secret | `cd app/infra && npm run destroy` + force-delete secret |
| 2 | 2026-07-11 | MicroVM **image** `mayfly-runner` (`arn:aws:lambda:ap-northeast-1:163703054402:microvm-image:mayfly-runner`, version 1.0, state CREATED) | `app/build-image.sh` | snapshot storage (~$0.08/GB-mo) | `aws lambda-microvms delete-microvm-image --image-identifier <ARN> --region ap-northeast-1` |
| 3 | 2026-07-11 | **MayflyDemoStack** (DynamoDB, API Lambda + Function URL, 2 SSM params) | `mayfly-demo/api/infra npm run deploy` | ~$0 idle | `cd mayfly-demo/api/infra && npm run destroy` |
| ★ | (pre-existing) | `CDKToolkit` stack in ap-northeast-1 | spike `cdk bootstrap` | ~$0 | left intentionally (standard CDK) |

**Key endpoints/ARNs**
- Webhook Function URL: `https://tszbder3gu3lnbefrzx2eyponi0njqdw.lambda-url.ap-northeast-1.on.aws/`
- Demo API URL: `https://fc4ueyqlq7a5krr7vu73r2dcqq0ygoaa.lambda-url.ap-northeast-1.on.aws/`
- ArtifactBucket: `mayflystack-artifactbucket7410c9ef-by42yn3gezmi`
- Image ARN: `arn:aws:lambda:ap-northeast-1:163703054402:microvm-image:mayfly-runner`

**Gotcha hit:** `get-microvm-image --image-identifier <name>` fails (needs the ARN) — the image ARN is
`arn:aws:lambda:<region>:<acct>:microvm-image:<name>`. `build-image.sh` now polls via `list-microvm-images`
(name-filtered) instead. The image built fine; only the poll was blind.

**No live MicroVMs yet** — none run until a `workflow_job` arrives (needs the GitHub App).

## Task 12 (deploy) — resources this WILL create when green-lit

`cd app/infra && npm run deploy` will create (all CDK-managed, `cdk destroy` removes):
- DynamoDB `JobsTable` (+ `state-index` GSI, PITR, TTL) — PAY_PER_REQUEST, ~$0 idle
- SQS `JobsQueue` + `JobsDLQ` — ~$0 idle
- SSM params `/mayfly/{webhookSecret,appId,installationId}` (placeholders; set real values out-of-band)
- Secrets Manager `/mayfly/appPrivateKey` (~$0.40/mo per secret)
- SNS `AlarmTopic` + 2 CloudWatch alarms (DLQ, reclaim)
- 3 Lambdas (webhook + Function URL, control, reconciler) — ARM64, pay-per-invoke
- EventBridge rule (2-min reconciler sweep)
- The MicroVM **runner image** (`build-image.sh`, Task 12) — snapshot storage (~$0.08/GB-mo)

**Gated on:** Mike creating the GitHub App (Administration:write + Actions:read), pointing its
webhook at the Function URL, and green-lighting the deploy + real MicroVM runs (cents).

## Teardown checklist (after Task 12)
- [ ] terminate any live MicroVMs (`reconcile` / `terminate-microvm`)
- [ ] delete the runner MicroVM image
- [ ] `cd app/infra && npm run destroy`
- [ ] **force-delete the secret** (else it lingers billable up to 30d + blocks re-deploy):
      `aws secretsmanager delete-secret --secret-id /mayfly/appPrivateKey --force-delete-without-recovery --region ap-northeast-1`
- [ ] confirm no MicroVMs remain: `aws lambda-microvms list-microvms --region ap-northeast-1`

## Still pending (Mike's action)
- [ ] **Rotate the GitHub PAT** — a fragment was pasted in chat earlier.
