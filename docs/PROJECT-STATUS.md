# Mayfly — project status & action plan

_Ephemeral GitHub Actions runners on AWS Lambda MicroVMs. Updated 2026-07-11._

## TL;DR

**The control plane is code-complete for v1** — built, tested (app 74 + infra 11 green), cdk-nag clean,
adversarially reviewed, fixes applied. The only thing between "code" and "proven working" is the **Phase 6
live deploy**, which is **yours** (it spends money and needs you to create a GitHub App). I cannot do that step.

## Done ✅ (all committed)

- Control plane: webhook (Function URL), control (idempotent provision + teardown-safe), reconciler
  (account-safe sweep). Libs: hmac, github, config, jobs, microvm, governance.
- CDK stack: DynamoDB(+GSI), SQS+DLQ, 3 Lambdas, alarms (DLQ / reclaim / quota-drop), image-build infra.
- MicroVM image pipeline: `build-image.sh` + two-target Dockerfile (verified `docker build` locally).
- Install flow: one-button GitHub App via manifest (`npm run setup-app`).
- Governance: fail-closed org/repo allowlist + per-owner concurrency quota (delayed-requeue backpressure).
- Docs: findings, deploy runbook, ADRs (webhook-ingress, handler-runtime), Phase 6 review + fixes, ledger.

## Left to do

### A. YOURS — the live deploy (gated: spends money + needs a GitHub App)

Follow `docs/runbooks/2026-07-11-phase6-deploy.md` exactly. In order:

1. [ ] **Rotate the GitHub PAT** (a fragment was pasted in chat earlier — security).
2. [ ] `cd app && npm ci` → `cd infra && npm ci && npm run deploy`  (stand up the stack)
3. [ ] `cd app && ./build-image.sh`  (create the `mayfly-runner` MicroVM image)
4. [ ] `npm run setup-app` → create + install the GitHub App on `mikeng-io/mayfly-test`
5. [ ] Trigger a plain-shell `runs-on: [self-hosted, mayfly]` job → verify provision→run→teardown→reconciler-clean
6. [ ] Teardown (Step 5 of the runbook) + update the ledger

**Only #1 and the decision to run this are blocking.** Everything else below is optional and I can do it
without you or any spend.

### B. MINE — optional, no spend (pick any, or none)

- [ ] **Article artifact** — a polished HTML summary of the design + findings (the original "article-first" goal; not yet built for the control plane).
- [ ] **Top-level README** tying the repo together (spike + app + docs).
- [ ] **Webhook hardening** — CloudFront + WAF + OAC (deferred by ADR `2026-07-10-webhook-ingress`); move the webhook secret from SSM String → Secrets Manager.
- [ ] **Docker-image-on-AWS variant** — build/publish the `docker` target image so `services:`/`docker` jobs work (v1 default image is lean/plain-shell).

### C. LATER — bigger forks (only if you decide to)

- [ ] **Hosted multi-tenant SaaS** (Option B): per-tenant isolation, metering/billing, abuse defense. Big commitment; the governance layer is its foundation.

## The single next action

**You:** rotate the PAT, then decide go/no-go on the Phase 6 deploy (A). It's ~cents and ~30 min following the runbook.
**Me (optional, in parallel):** say the word and I'll knock out any B item while you deploy — my default pick is the **article artifact**, since that's the project's original purpose.
