# Mayfly — project status

_Ephemeral GitHub Actions runners on AWS Lambda MicroVMs. Updated 2026-07-11._

## TL;DR

**Deployed and verified live end-to-end on real AWS (ap-northeast-1).** A real `workflow_job` provisioned
a Graviton MicroVM, a JIT runner ran the job to success, posted its fingerprint, and teardown reaped the VM.
Control plane + demo API are live; the public demo is up. AWS is at ~$0 idle (0 MicroVMs running).

## Done ✅ (all committed)

- **Control plane** — webhook (Function URL), control (idempotent provision + teardown-safe), reconciler
  (account-safe sweep). Libs: hmac, github, config, jobs, microvm, governance, manifest.
- **CDK stack** — DynamoDB(+GSI), SQS+DLQ, 3 Lambdas, **3 alarms** (DLQ / reclaim / quota-drop), image-build infra.
- **Governance** — fail-closed org/repo allowlist + per-owner concurrency quota (delayed-requeue backpressure).
- **Image pipeline** — `build-image.sh` + two-target Dockerfile; `mayfly-runner` image built (v1.0).
- **Install flow** — one-button GitHub App via manifest (`npm run setup-app`).
- **Deployed + verified** — MayflyStack + MayflyDemoStack live; GitHub App `mayfly` (id 4267032) installed on
  `mikeng-io/mayfly-demo`; end-to-end run proven (see `app/AWS-LEDGER.md`).
- **Docs** — README (+ architecture diagram), findings (with real pricing + IAM facts), ADRs
  (`docs/adr/` 0002-webhook-ingress, 0003-handler-runtime), reviews, deploy runbook, cost model + calculator.

## Live endpoints

- Webhook Function URL: `https://tszbder3gu3lnbefrzx2eyponi0njqdw.lambda-url.ap-northeast-1.on.aws/`
- Demo API: `https://fc4ueyqlq7a5krr7vu73r2dcqq0ygoaa.lambda-url.ap-northeast-1.on.aws/`
- Public demo site: https://mikeng-io.github.io/mayfly-demo/

## Open items

### Decisions (yours)
- [ ] **Leave it running** (cheap, for the demo) **or tear down** (runbook Step 5 + `delete-secret --force-delete-without-recovery`).
- [ ] **Rotate the GitHub PAT** (a fragment was pasted in chat earlier — security).

### Optional, no spend (mine, on request)
- [ ] **Webhook hardening** — CloudFront + WAF + OAC (deferred by ADR-0002, `docs/adr/0002-webhook-ingress.md`); move the webhook secret SSM String → Secrets Manager.
- [ ] **Docker-image-on-AWS variant** — build/publish the `docker` target image so `services:`/`docker` jobs work (default image is lean/plain-shell).
- [ ] **Richer live lifecycle** on the demo (queued→booting→running) — needs the control plane to emit provisioning events.

### Later (bigger forks)
- [ ] **Hosted multi-tenant SaaS** — per-tenant isolation, metering/billing, abuse defense. The governance layer is its foundation.

> Article content is produced elsewhere; this repo stays technical + stack.
