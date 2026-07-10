# AWS resource ledger — Mayfly control plane

**Account:** 163703054402 (`user/mike.ng`) · **Region:** ap-northeast-1 (Tokyo)

> Live record of everything created **directly in AWS** for the control plane, so teardown never
> needs CloudTrail archaeology. Everything is CDK-managed (`app/infra`) — no manual resource creation.

## Current state (Phases 1–5 complete, NOT deployed)

**Nothing has been deployed for the control plane.** Phases 1–5 are pure code + local tests + a
single read-only probe. The stack is defined but not `cdk deploy`-ed.

| # | When | Resource | Created by | Cost | How to destroy |
|---|------|----------|-----------|------|----------------|
| — | 2026-07-10 | **Read-only SDK probe** (`ListMicrovmImages` in Tokyo) — created **nothing** | `app/scripts/sdk-probe.ts` | $0 | n/a (read-only) |
| ★ | (pre-existing) | `CDKToolkit` stack in ap-northeast-1 | spike `cdk bootstrap` | ~$0 | left intentionally (standard CDK) |

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
