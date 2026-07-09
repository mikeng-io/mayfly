# Mayfly Control Plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven Mayfly spikes into a deployable, event-driven control plane that provisions an ephemeral Lambda MicroVM runner per queued GitHub Actions job and reaps it — all in CDK + TypeScript.

**Architecture:** GitHub `workflow_job` webhook → **Function URL Lambda** (verify HMAC, filter, 2xx) → **SQS** (short delay) → **control Lambda** (re-check queued, fork-check, `run-microvm`, mint JIT, hand it over the L7 endpoint, record correlation) → runner runs one job → **teardown** (`completed` webhook + a scheduled **reconciler** that sweeps orphans). State + correlation in **DynamoDB**; config in **SSM**; auth via a **GitHub App**.

**Tech Stack:** AWS CDK v2 (TypeScript), `aws-cdk-lib/aws-lambda-nodejs` (esbuild bundling), Node 20 Lambdas, `@aws-sdk/client-lambda-microvms` + `client-dynamodb` + `client-sqs` + `client-ssm`, `vitest` for unit tests, Go for the in-VM launcher. Reuse the **verified** behavior in `spike/phase2-aws/*` and `spike/phase2b-docker/*` as the reference implementation.

## Global Constraints

- **Scope = v1, article-first, single trust domain.** No multi-tenant, no warm pool autoscaling. A **fixed warm behavior is out**; v1 launches per-job (Approach B — proven), records everything, reaps reliably. (Suspended-pool / Approach C is a later ADR.)
- **Region:** MicroVM GA region only — default **`ap-northeast-1`** (Tokyo). The account default region differs; **every AWS call pins the region explicitly.**
- **Arch:** MicroVMs are **ARM64**. The runner image + launcher build arm64.
- **AWS-API facts (verified, do not re-derive):** CLI/SDK service is `lambda-microvms`; `get-microvm-image`/`run-microvm --image-identifier` need the **image ARN** (resolve name→ARN via `list-microvm-images`); microvm ops take the **microvm ID**; failure state is `CREATION_FAILED`; `--idle-policy` min `maxIdleDurationSeconds` is 60; run job-carrying VMs with **auto-suspend off**; do **not** pass `--hooks` shorthand (bogus 403). Endpoint: `https://<endpoint>` + header `X-aws-proxy-auth`, default port 8080.
- **GitHub:** JIT via `POST /repos/{o}/{r}/actions/runners/generate-jitconfig` (returns `encoded_jit_config`); GitHub **App** perms Administration:write + Actions:read; 1-hour installation tokens from the webhook's `installation.id`; HMAC header `X-Hub-Signature-256` = `sha256=<hex>` over the raw body, constant-time compare.
- **Quality gates (CI fails on violation):** `tsc --strict`, ESLint + Prettier, `cdk-nag` (AwsSolutions) pass or documented suppression, `vitest run` green. Secrets only via SSM/Secrets Manager — never in code. Tag everything `project=mayfly`.
- **Commits:** frequent, one per task, trailer with the repo's Co-Authored-By / Claude-Session lines.

---

## File structure (new `app/` tree — the real project, beside `spike/`)

```
app/
  infra/
    bin/mayfly.ts                 # CDK app entry (env region pinned to Tokyo)
    lib/mayfly-stack.ts           # single v1 stack (DynamoDB, SSM, SQS, 3 Lambdas, Function URL, Scheduler)
    package.json cdk.json tsconfig.json
    test/mayfly-stack.test.ts     # CDK assertions + cdk-nag
  src/
    handlers/
      webhook.ts                  # Function URL: verify HMAC, filter queued+label, enqueue; route completed→teardown
      control.ts                  # SQS consumer: re-check queued, fork-check, run-microvm, JIT hand-off, record
      reconciler.ts               # Scheduler: sweep orphaned/overdue microvms
    lib/
      hmac.ts                     # verifySignature(secret, rawBody, header): boolean
      github.ts                   # appJwt(), installationToken(), generateJitConfig(), getRun(), isForkPR()
      microvm.ts                  # runMicrovm(), authToken(), postJit(), terminate(), listRunning(), imageArn()
      jobs.ts                     # DynamoDB repo: put/get/delete correlation; idempotency by jobId
      config.ts                   # env + SSM config loader
      types.ts                    # shared types (JobRecord, WorkflowJobEvent, …)
  test/                           # vitest unit tests for lib/*
  runtime/launcher/main.go        # productionized in-VM launcher (from spike phase2)
  image/Dockerfile                # MicroVM runner image (arm64: runner + launcher; docker optional via build arg)
```

*The `spike/` tree stays as the validated reference and is not deleted.*

---

## Phase 1 — Scaffold + pure-logic libs (TDD)

### Task 1: App scaffold + CDK skeleton
**Files:** create `app/infra/{bin/mayfly.ts,lib/mayfly-stack.ts,package.json,cdk.json,tsconfig.json}`, `app/src/lib/types.ts`, `app/package.json` (root workspace for src + tests), `app/test/` (vitest config).
**Deliverable:** `cd app/infra && npm i && npx cdk synth` produces an empty stack; `cd app && npm i && npx vitest run` runs (0 tests).
- [ ] Root `app/package.json` with `vitest`, `typescript`, `@types/node`, esbuild; `test` script = `vitest run`.
- [ ] `infra` CDK app (mirror `spike/phase2-aws/infra` package.json/cdk.json/tsconfig) with an empty `MayflyStack`.
- [ ] `types.ts`: `WorkflowJobEvent` (action, workflow_job{id,run_id,labels,status}, repository{owner,name}, installation{id}), `JobRecord` ({jobId, runId, microvmId, runnerName, state, createdAt}).
- [ ] Commit `feat: scaffold mayfly control-plane app + CDK skeleton`.

### Task 2: HMAC verification (`lib/hmac.ts`) — TDD
**Interfaces — Produces:** `verifySignature(secret: string, rawBody: Buffer|string, header: string|undefined): boolean`.
- [ ] Failing test `app/test/hmac.test.ts`:
```ts
import { verifySignature } from '../src/lib/hmac';
import { createHmac } from 'node:crypto';
const secret = 's3cr3t'; const body = '{"a":1}';
const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
test('accepts a valid signature', () => expect(verifySignature(secret, body, good)).toBe(true));
test('rejects a bad signature', () => expect(verifySignature(secret, body, 'sha256=deadbeef')).toBe(false));
test('rejects missing header', () => expect(verifySignature(secret, body, undefined)).toBe(false));
```
- [ ] Run `npx vitest run test/hmac.test.ts` → FAIL (module not found).
- [ ] Implement `src/lib/hmac.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifySignature(secret: string, rawBody: Buffer | string, header?: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```
- [ ] Run → PASS. Commit `feat: HMAC webhook signature verification`.

### Task 3: GitHub App auth + API (`lib/github.ts`) — TDD the JWT, integration for tokens
**Interfaces — Produces:** `appJwt(appId, privateKeyPem): string`; `installationToken(jwt, installationId): Promise<string>`; `generateJitConfig(token, owner, repo, name, labels): Promise<string>`; `getRun(token, owner, repo, runId): Promise<{event, headRepoId, baseRepoId}>`; `isForkPR(run): boolean`.
- [ ] Failing test `app/test/github.test.ts` for the pure pieces (JWT claims + `isForkPR`):
```ts
import { decodeJwtClaims, isForkPR } from '../src/lib/github';
test('isForkPR true when head repo differs', () =>
  expect(isForkPR({ event:'pull_request', headRepoId: 2, baseRepoId: 1 })).toBe(true));
test('isForkPR false for internal push', () =>
  expect(isForkPR({ event:'push', headRepoId: 1, baseRepoId: 1 })).toBe(false));
```
- [ ] Run → FAIL. Implement `github.ts`: `appJwt` (RS256 via `node:crypto` sign, claims iss=appId, iat=now-60, exp=now+540), `decodeJwtClaims` (base64url payload), `isForkPR(run)=run.event==='pull_request' && run.headRepoId!==run.baseRepoId`, and the `fetch`-based API calls (`installationToken`, `generateJitConfig`, `getRun`) mirroring the verified curl calls in `spike/phase2-aws/run-spike-aws.sh` and `docs/research/github-actions-jit-runners.md`. Return `encoded_jit_config` from `generateJitConfig`.
- [ ] Run → PASS (pure pieces). API calls are covered by the Phase 6 integration checkpoint. Commit `feat: GitHub App auth + JIT/run API`.

### Task 4: Config loader (`lib/config.ts`) — TDD
**Interfaces — Produces:** `loadConfig(): Config` where `Config = {region, imageName, jobsTable, queueUrl, repo:{owner,name}, labels:string[], webhookSecretParam, appIdParam, appKeyParam, installationId, maxRuntimeSeconds}`. Reads env vars (set by CDK), resolves SSM SecureString params lazily via a `getSecret(param)` helper.
- [ ] Failing test asserting `loadConfig` throws on a missing required env and returns parsed values when present. Implement reading `process.env` + defaults (labels `['self-hosted','mayfly']`, region `ap-northeast-1`, maxRuntime `3600`). Commit.

---

## Phase 2 — State + queue + webhook (deployable slice)

### Task 5: DynamoDB jobs repo (`lib/jobs.ts`) — TDD with aws-sdk-client-mock
**Interfaces — Produces:** `putJob(rec)`, `getJob(jobId)`, `deleteJob(jobId)`, `claimJob(jobId)` (conditional put for idempotency — returns false if already present). PK = `jobId` (string).
- [ ] Failing tests using `aws-sdk-client-mock` for `@aws-sdk/lib-dynamodb`: `claimJob` returns true first time, false on `ConditionalCheckFailedException`; `getJob` maps item→JobRecord.
- [ ] Implement with `DynamoDBDocumentClient`; `claimJob` = `PutCommand` with `ConditionExpression: 'attribute_not_exists(jobId)'`, catch conditional failure → false. Commit `feat: DynamoDB jobs repo with idempotent claim`.

### Task 6: Stack — DynamoDB + SSM + SQS + config wiring
**Files:** modify `app/infra/lib/mayfly-stack.ts`; test `app/infra/test/mayfly-stack.test.ts`.
- [ ] Add: `Table` (PK `jobId`, `PAY_PER_REQUEST`, PITR, TTL attr `expiresAt`, `RemovalPolicy.DESTROY`), `Queue` (visibility 300s, `deliveryDelay: Duration.seconds(20)`, a DLQ with maxReceiveCount 3), SSM `StringParameter` placeholders for `webhookSecret`/`appId`/`installationId` (values set out-of-band; the private key in **Secrets Manager**). Tag `project=mayfly`.
- [ ] CDK assertion test: table has PK `jobId` + PITR; queue has a DLQ + delay; `cdk-nag` AwsSolutions with justified suppressions. Run `npx vitest run` + `npx cdk synth`. Commit `feat: state + queue infra`.

### Task 7: Webhook Lambda (`handlers/webhook.ts`) + Function URL — TDD handler, integration for URL
**Interfaces — Consumes:** `verifySignature`, `jobs`, SQS SendMessage. **Produces:** Function URL handler returning 2xx fast.
- [ ] Failing test `app/test/webhook.test.ts` (invoke the handler with a fake Function URL event): rejects bad signature → 401; ignores `action!=='queued'` → 200 no-enqueue; ignores label mismatch → 200 no-enqueue; on `queued` + label match + valid sig → 200 and one SQS `SendMessageCommand` (mock) with `{jobId, runId, installationId, owner, repo}`; on `completed` → enqueues a teardown message. Idempotency: same `jobId` twice → single enqueue (via `claimJob`).
- [ ] Implement handler: parse raw body, `verifySignature` with the SSM secret, filter, `SendMessage`, return `{statusCode:200}`. Keep it fast (no provisioning here).
- [ ] Add to stack: `NodejsFunction` for webhook + a **Function URL** (auth NONE — HMAC is the auth), env wiring, grant SQS send + SSM read. CDK assertion for the Function URL.
- [ ] Run tests → PASS; `cdk synth`. Commit `feat: webhook receiver + Function URL`.

---

## Phase 3 — MicroVM client + runtime image

### Task 8: MicroVM client (`lib/microvm.ts`) — thin typed wrapper (integration-tested)
**Interfaces — Produces:** `imageArn(name)`, `runMicrovm(imageArn)→{microvmId,endpoint}`, `waitRunning(id)`, `authToken(id)→string`, `postJit(endpoint, token, encodedJit)`, `terminate(id)`, `listActive()→id[]`. Ports the **verified** logic from `spike/phase2-aws/run-spike-aws.sh` to `@aws-sdk/client-lambda-microvms` + `fetch` for the endpoint. Auto-suspend **off** (no idle policy) on run; `maximumDurationInSeconds` from config.
- [ ] Unit-test the pure bits (endpoint URL building, header shape). The AWS calls are covered by the Phase 6 integration checkpoint (they were validated live in the spike). Commit `feat: typed Lambda MicroVM client`.

### Task 9: Productionize the runtime image (`runtime/launcher/main.go` + `image/Dockerfile`)
**Files:** copy `spike/phase2-aws/app/launcher/main.go` → `app/runtime/launcher/main.go` (already proven: binds sync, `/jit`, `/status`, lifecycle hooks, stays alive); copy the Dockerfile (arm64 runner + launcher). Add a `--build-arg WITH_DOCKER` variant that installs dockerd (from `spike/phase2b-docker`) for the docker-capable image.
- [ ] Deliverable: `docker build` locally succeeds for both variants (arm64). No AWS needed. Commit `feat: productionize MicroVM runner image`.

---

## Phase 4 — Control Lambda (the provisioner)

### Task 10: Control handler (`handlers/control.ts`) — TDD orchestration with mocks
**Interfaces — Consumes:** `github`, `microvm`, `jobs`, `config`. **Produces:** SQS-consumer handler.
- [ ] Failing test `app/test/control.test.ts` (mock github + microvm + jobs): on a `queued` message → mints installation token, **re-checks the run is still queued** (skip+return if not), **fork-check** (fork ⇒ launch with no VPC SG — v1 just records `trust:'fork'`), `runMicrovm`, `waitRunning`, `authToken`, `generateJitConfig(name=jobId)`, `postJit`, `putJob({jobId,microvmId,runnerName,state:'running'})`. On a `completed` message → `getJob`, `terminate(microvmId)`, `deleteJob`. Assert the call order and that a failed `postJit` triggers `terminate` (no leak).
- [ ] Implement to satisfy the test, porting the proven sequence from `run-spike-aws.sh`/`docker-spike.sh`.
- [ ] Add to stack: control `NodejsFunction` with the SQS event source (batchSize 1), env, IAM for `lambda-microvms:*` (scoped), DynamoDB RW, SSM/Secrets read. Commit `feat: control-plane provisioner Lambda`.

---

## Phase 5 — Teardown + reconciler

### Task 11: Reconciler (`handlers/reconciler.ts`) + Scheduler — TDD sweep logic
**Interfaces — Consumes:** `microvm.listActive`, `jobs`. **Produces:** scheduled handler that terminates orphans.
- [ ] Failing test: given active microvms not present as `running` JobRecords (or past `maxRuntime`), the handler calls `terminate` on each and cleans the record. Given healthy in-flight ones, it leaves them. (Two-phase: only terminate ones seen orphaned across the grace window — track a `firstSeenOrphan` marker in DynamoDB.)
- [ ] Implement + add EventBridge **Scheduler** (rate 2 min) target = reconciler Lambda. Commit `feat: reconciler sweep + schedule`.

---

## Phase 6 — Wire, deploy, integration checkpoint (the real end-to-end)

### Task 12: Deploy + live integration test
**Deliverable:** the whole thing works against `mikeng-io/mayfly-test`.
- [ ] `cd app/infra && npm run deploy` (Tokyo). Set SSM/Secrets values (webhook secret, App id, installation id, private key). **Record every created resource in `app/AWS-LEDGER.md`.**
- [ ] Create/point a **GitHub App** at the Function URL (webhook), install on the repo, `Administration:write`+`Actions:read`.
- [ ] Build + create the MicroVM image via a `build-image.sh` (reuse the proven one), record it.
- [ ] Trigger a real `workflow_job` (open a PR / dispatch a job with `runs-on:[self-hosted,mayfly]`) → assert: webhook 2xx, SQS message, control Lambda provisions a MicroVM, the job runs to `completed/success`, teardown terminates it, reconciler confirms none orphaned. Capture logs as evidence.
- [ ] **Teardown** after: terminate microvms, delete image, `cdk destroy`. Update ledger.
- [ ] Commit `feat: deploy + green end-to-end control plane`.

---

## Self-review

- **Spec coverage** (`docs/superpowers/specs/2026-07-07-mayfly-design.md`): webhook (T7), SQS+delay (T6), control/provision (T10), fork-check/trust (T10), reconciler (T11), DynamoDB correlation+idempotency (T5), GitHub App auth (T3), HMAC (T2), MicroVM lifecycle (T8/T9), 2xx-fast (T7), deploy+CDK (T6/T12) — all mapped.
- **Deferred by design (recorded, not gaps):** suspended warm pool (Approach C), VPC-private-access governance beyond the fork-trust boolean, multi-region, multi-tenant, x86/QEMU. These are post-v1 ADRs.
- **Integration-vs-unit honesty:** pure logic (HMAC, JWT, fork-check, jobs, sweep) is TDD'd with mocks; the AWS-glue (MicroVM run/JIT/terminate) was **validated live in the spikes** and is re-verified in the T12 integration checkpoint rather than mock-unit-tested — appropriate for a thin SDK wrapper over a proven flow.
