# Mayfly Control Plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven Mayfly spikes into a deployable, event-driven control plane that provisions an ephemeral Lambda MicroVM runner per queued GitHub Actions job and reaps it — all in CDK + TypeScript.

**Architecture:** GitHub `workflow_job` webhook → **Function URL Lambda** (verify HMAC, filter, 2xx) → **SQS** (short delay) → **control Lambda** (re-check queued, fork-check, `run-microvm`, mint JIT, hand it over the L7 endpoint, record correlation) → runner runs one job → **teardown** (`completed` webhook + a scheduled **reconciler** that sweeps orphans). State + correlation in **DynamoDB**; config in **SSM**; auth via a **GitHub App**.

**Tech Stack:** AWS CDK v2 (TypeScript), `aws-cdk-lib/aws-lambda-nodejs` (esbuild bundling), Node 20 Lambdas, `@aws-sdk/client-lambda-microvms` + `client-dynamodb` + `client-sqs` + `client-ssm`, `vitest` for unit tests, Go for the in-VM launcher. Reuse the **verified** behavior in `spike/phase2-aws/*` and `spike/phase2b-docker/*` as the reference implementation.

## Global Constraints

- **Scope = v1, single trust domain, per-job launch (Approach B — proven).** No warm pool, no multi-tenant. **Honest note (per review):** v1 makes the runner *work reliably*; it does **not** demonstrate the two "why Mayfly" claims — warm-start-at-zero-idle-cost (needs Approach C / suspended pool) and fork-isolation-via-VPC-SG (v1 only *records* trust, defers the network gate). Both are explicit post-v1 ADRs; don't market v1 as proving them.
- **Idempotency lives in the CONTROL Lambda, not the webhook.** SQS is at-least-once → the control handler must be a **re-drivable state transition** keyed on `jobId` (record the `microvmId` the instant `run-microvm` returns; a redelivery that finds a live VM skips; a partial-crash record is reconciled). The webhook is stateless: verify → filter → enqueue → 2xx.
- **Reconciler is account-safe:** it reconciles **our DynamoDB JobRecords ↔ live MicroVMs we launched** (every launched `microvmId` is recorded), and tags every VM `project=mayfly`. It must **never** blindly terminate all MicroVMs in the region.
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
      microvm.ts                  # runMicrovm() (w/ network connectors + tag), authToken(), postJit(), terminate(), getMicrovm(), imageArn()
      jobs.ts                     # DynamoDB repo: re-drivable provisioning claim (beginProvisioning/attachMicrovm/markRunning), get/delete, listByState
      config.ts                   # env + SSM config loader (incl. MAX_CONCURRENT, MAX_RUNTIME, PROVISION_TTL)
      types.ts                    # shared types (JobRecord{state}, WorkflowJobEvent, …)
  scripts/sdk-probe.ts            # one-off: validate @aws-sdk/client-lambda-microvms against Tokyo (Task 7.5)
  test/                           # vitest unit tests for lib/* (aws-sdk-client-mock for AWS calls)
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
**Interfaces — Produces:** `loadConfig(): Config` where `Config = {region, imageName, jobsTable, jobsStateIndex, queueUrl, repo:{owner,name}, labels:string[], webhookSecretParam, appIdParam, appKeyParam, installationId, maxRuntimeSeconds, maxConcurrent, provisionTtlSeconds}`. Reads env vars (set by CDK), resolves SSM SecureString params lazily via a `getSecret(param)` helper. Defaults: `maxConcurrent=5`, `provisionTtlSeconds=120`.
- [ ] Failing test asserting `loadConfig` throws on a missing required env and returns parsed values when present. Implement reading `process.env` + defaults (labels `['self-hosted','mayfly']`, region `ap-northeast-1`, maxRuntime `3600`). Commit.

---

## Phase 2 — State + queue + webhook (deployable slice)

### Task 5: DynamoDB jobs repo (`lib/jobs.ts`) — re-drivable claim, TDD
**JobRecord.state:** `provisioning | running | done`. Record = `{jobId(PK), state, microvmId?, endpoint?, runnerName?, updatedAt, expiresAt(TTL)}`. GSI on `state` for the reconciler.
**Interfaces — Produces:**
- `beginProvisioning(jobId): 'proceed' | 'skip'` — conditional put that succeeds (→`proceed`) only if **no record exists OR an existing `provisioning` record is stale** (`updatedAt` older than `PROVISION_TTL=120s`, i.e. a crashed attempt). A `running` or fresh `provisioning` record → `skip` (dedupes SQS at-least-once redelivery).
- `attachMicrovm(jobId, microvmId, endpoint)` — update the record **the instant `run-microvm` returns**, so any redelivery/reconciler can find and reap the VM.
- `markRunning(jobId)`, `getJob(jobId)`, `deleteJob(jobId)`, `listByState(state)` (reconciler, via the GSI).
- [ ] Failing tests (`aws-sdk-client-mock` for `@aws-sdk/lib-dynamodb`): `beginProvisioning` → `proceed` when absent; → `skip` on `ConditionalCheckFailedException`; → `proceed` when existing record is stale; `attachMicrovm` issues an `UpdateCommand`; `getJob` maps item→JobRecord; `listByState` queries the GSI.
- [ ] Implement with `DynamoDBDocumentClient`. `beginProvisioning` = `PutCommand`, `ConditionExpression: 'attribute_not_exists(jobId) OR (#s = :prov AND updatedAt < :stale)'`.
- [ ] Commit `feat: DynamoDB jobs repo with re-drivable provisioning claim`.

### Task 6: Stack — DynamoDB + SSM + SQS + config wiring
**Files:** modify `app/infra/lib/mayfly-stack.ts`; test `app/infra/test/mayfly-stack.test.ts`.
- [ ] Add: `Table` (PK `jobId`, **GSI `state-index` on `state`** for the reconciler's `listByState`, `PAY_PER_REQUEST`, PITR, TTL attr `expiresAt`, `RemovalPolicy.DESTROY`), `Queue` (visibility 300s, `deliveryDelay: Duration.seconds(20)`, a DLQ with maxReceiveCount 3), SSM `StringParameter` placeholders for `webhookSecret`/`appId`/`installationId` (values set out-of-band; the private key in **Secrets Manager**). Tag the stack `project=mayfly`.
- [ ] **Observability (spec calls these first-class):** CloudWatch **alarm on DLQ `ApproximateNumberOfMessagesVisible ≥ 1`**; a custom-metric alarm on the reconciler's `reclaimed` count (VMs the control plane leaked); a GitHub-API-quota metric hook (logged from `github.ts`, alarm optional). SNS topic for alarms (email set out-of-band).
- [ ] CDK assertion test: table has PK `jobId` + the `state-index` GSI + PITR; queue has a DLQ + delay; DLQ alarm exists; `cdk-nag` AwsSolutions with justified suppressions. Run `npx vitest run` + `npx cdk synth`. Commit `feat: state + queue infra + DLQ/reclaim alarms`.

### Task 7: Webhook Lambda (`handlers/webhook.ts`) + Function URL — **stateless**, TDD
**Interfaces — Consumes:** `verifySignature`, SQS SendMessage. **Produces:** fast 2xx handler. **No DynamoDB here** — idempotency belongs to the control Lambda.
- [ ] Failing test `app/test/webhook.test.ts` (fake Function URL event): **decode `isBase64Encoded` body before HMAC**; bad/absent signature → 401; `action` not in `{queued,completed}` → 200 no-enqueue; label mismatch on `queued` → 200 no-enqueue; `queued`+label+valid sig → 200 + one `SendMessageCommand` `{type:'provision', jobId, runId, installationId, owner, repo, labels}`; `completed` → 200 + `{type:'teardown', jobId, installationId, owner, repo}`.
- [ ] Implement: `const raw = event.isBase64Encoded ? Buffer.from(event.body,'base64') : Buffer.from(event.body ?? '')` **before** `verifySignature`; then filter + `SendMessage`; `return {statusCode:200}`. No provisioning, no DynamoDB.
- [ ] Add to stack: `NodejsFunction` + **Function URL** (auth NONE — HMAC is the auth; IP-allowlist to GitHub's published webhook ranges noted as future hardening), env, grant SQS send + SSM read.
- [ ] Run tests → PASS; `cdk synth`. Commit `feat: stateless webhook receiver + Function URL`.

---

## Phase 3 — MicroVM client + runtime image

### Task 7.5: Validate `@aws-sdk/client-lambda-microvms` against Tokyo (live preflight)
The spikes proved the **CLI**, not the JS SDK (service GA 2026-06-22). De-risk the package + creds first.
- [ ] `app/scripts/sdk-probe.ts`: `new LambdaMicrovmsClient({region:'ap-northeast-1'}).send(new ListMicrovmImagesCommand({}))` (creds from repo `.env`). Run → expect a (possibly empty) list; no package/auth/unknown-command error. **Read-only, no cost.** If the package/shape differs from docs, record the real one and adjust Task 8. Commit `chore: validate lambda-microvms JS SDK`.

### Task 8: MicroVM client (`lib/microvm.ts`) — typed wrapper, command-shape TDD
**Interfaces — Produces:** `imageArn(name)` (name→ARN via `ListMicrovmImagesCommand` — image ops need the ARN), `runMicrovm(imageArn)→{microvmId,endpoint}`, `waitRunning(id)`, `authToken(id)→string`, `postJit(endpoint, token, encodedJit)`, `terminate(id)`, `listOurActive(microvmIds)→id[]`. Ports the **verified** `spike/phase2-aws/run-spike-aws.sh` sequence.
- `runMicrovm` **must** pass network connectors + tag: `ingressNetworkConnectors:[…:ALL_INGRESS]`, `egressNetworkConnectors:[…:INTERNET_EGRESS]` (**no egress = no GitHub = no job**), **no** `idlePolicy` (auto-suspend off), `maximumDurationInSeconds` from config, `project=mayfly` tag if `RunMicrovmCommand` supports it.
- `waitRunning` treats `CREATION_FAILED`/terminal-non-`RUNNING` as an error (don't spin to timeout).
- [ ] **Command-shape unit tests** (`aws-sdk-client-mock`): `runMicrovm` sends `RunMicrovmCommand` with the connector ARNs and **no** `idlePolicy`; `imageArn` resolves name→ARN; `waitRunning` throws on `CREATION_FAILED`; `postJit` `fetch`es `https://<endpoint>/jit` with `X-aws-proxy-auth` + `X-aws-proxy-port:8080`. Live re-verified in Task 12; these catch wrong command shapes early.
- [ ] Commit `feat: typed Lambda MicroVM client (connectors + auto-suspend-off)`.

### Task 9: Productionize the runtime image (`runtime/launcher/main.go` + `image/Dockerfile`)
**Files:** copy `spike/phase2-aws/app/launcher/main.go` → `app/runtime/launcher/main.go` (already proven: binds sync, `/jit`, `/status`, lifecycle hooks, stays alive); copy the Dockerfile (arm64 runner + launcher). Add a `--build-arg WITH_DOCKER` variant that installs dockerd (from `spike/phase2b-docker`) for the docker-capable image.
- [ ] Deliverable: `docker build` locally succeeds for both variants (arm64). No AWS needed. Commit `feat: productionize MicroVM runner image`.

---

## Phase 4 — Control Lambda (the provisioner)

### Task 10: Control handler (`handlers/control.ts`) — TDD orchestration with mocks
**Interfaces — Consumes:** `github`, `microvm`, `jobs`, `config`. **Produces:** SQS-consumer handler. This is where **idempotency + teardown** live.
**Provision flow (re-drivable):**
1. `beginProvisioning(jobId)` → if `skip`, ack the message and return (SQS at-least-once dedupe / already handled).
2. Mint installation token; **re-check the run is still `queued`** via `GET runs/{runId}` — if not, `deleteJob` + return (handles `completed`-before-provision).
3. **Fork-check `isForkPR` — fail-closed:** on any error treat as fork/untrusted; v1 records `trust:'fork'` (the VPC-SG network gate is a documented deferral, not silently skipped).
4. `runMicrovm(imageArn)` → **immediately `attachMicrovm(jobId, microvmId, endpoint)`** (so a redelivery/reconciler can find and reap this VM even if a later step crashes).
5. `waitRunning` → `authToken` → `github.generateJitConfig(name=jobId)` → `postJit` → `markRunning(jobId)`.
- **`try/finally` teardown at every stage after step 4:** if `waitRunning` sees `CREATION_FAILED`, or `authToken`/`generateJitConfig`/`postJit`/`markRunning` throw → `terminate(microvmId)` and leave the record for the reconciler (or delete it) — **no leaked VM at any failure point**, not just `postJit`.
- **Concurrency cap:** the control Lambda has **reserved concurrency** (config `MAX_CONCURRENT`, default 5) so a matrix job (→50 `queued` events) can't exceed the ~5 TPS `RunMicrovm` limit; `runMicrovm` retries `ThrottlingException` with jittered backoff. Excess SQS messages wait/retry — DLQ after N.
**Teardown flow (`completed` message):** `getJob` → `terminate(microvmId)` (idempotent — ignore already-gone) → `deleteJob`.
- [ ] Failing test `app/test/control.test.ts` (mock github + microvm + jobs): `beginProvisioning→skip` ⇒ no `runMicrovm`; happy path asserts call order + `attachMicrovm` fires right after `runMicrovm`; `waitRunning` throwing `CREATION_FAILED` ⇒ `terminate` called (no leak); `postJit` throwing ⇒ `terminate`; fork-check throwing ⇒ treated as fork (not fail-open); `completed` ⇒ `terminate`+`deleteJob`.
- [ ] Implement, porting the proven sequence from `run-spike-aws.sh`/`docker-spike.sh`.
- [ ] Add to stack: control `NodejsFunction`, SQS event source (batchSize 1), **reservedConcurrentExecutions**, env, **least-priv IAM** (enumerate `lambda-microvms:RunMicrovm`,`TerminateMicrovm`,`GetMicrovm`,`ListMicrovms`,`ListMicrovmImages`,`GetMicrovmImage`,`CreateMicrovmAuthToken` — **not** `lambda-microvms:*`), DynamoDB RW, SSM/Secrets read. Commit `feat: control-plane provisioner Lambda (idempotent + teardown-safe)`.

---

## Phase 5 — Teardown + reconciler

### Task 11: Reconciler (`handlers/reconciler.ts`) + Scheduler — TDD sweep logic
**Interfaces — Consumes:** `jobs.listByState`, `microvm.getMicrovm`/`terminate`, `config`. **Produces:** scheduled handler that reaps our overdue VMs.
**Account-safe by construction — record-driven, never list-all:** the reconciler iterates **our own `JobRecords`** (we recorded every `microvmId` we launched via `attachMicrovm`); it must **never** enumerate and terminate all MicroVMs in the region (that could kill unrelated VMs in Mike's Tokyo account). The `project=mayfly` tag is belt-and-suspenders, not the primary guard.
- For each record in `provisioning`/`running`: `getMicrovm(microvmId)` — if past `maxRuntime` (record `createdAt` + `MAX_RUNTIME`), or the VM is already terminal/gone, `terminate` (idempotent) + `deleteJob`. Healthy in-flight ones are left.
- **Two-phase (grace window):** only terminate a record seen overdue across the grace window — track a `firstSeenOverdue` marker so a job that's legitimately mid-run isn't reaped on a clock edge. Handles the `completed`-webhook-lost case (record stuck `running`, VM idle) too.
- Emit a ` reclaimed` metric per terminate (feeds the reclaim alarm in Task 6).
- [ ] Failing test: a `running` record past `maxRuntime` (past the grace window) ⇒ `terminate`+`deleteJob`; a fresh `running` record ⇒ left; a record whose VM `getMicrovm` reports gone ⇒ `deleteJob`; asserts it **only** acts on records from `listByState`, never a region-wide list.
- [ ] Implement + add EventBridge **Scheduler** (rate 2 min) target = reconciler Lambda. Commit `feat: account-safe reconciler sweep + schedule`.

---

## Phase 6 — Wire, deploy, integration checkpoint (the real end-to-end)

### Task 11.7: One-button GitHub App install (manifest flow) — DONE
**Distribution model:** Mayfly is **self-hosted / BYO-cloud** (adopter deploys their own stack +
App; not a hosted SaaS). To make step "create a GitHub App" frictionless:
- `src/lib/manifest.ts`: `buildManifest` (administration:write + actions:read + `workflow_job`), `exchangeManifestCode` (redirect code → appId/pem/webhookSecret), `persistCredentials` (SSM PutParameter + Secrets Manager PutSecretValue), `newAppUrl`/`installUrl`. TDD with `aws-sdk-client-mock`.
- `scripts/setup-app.ts`: thin local server — renders the manifest form pre-seeded with the deployed Function URL, CSRF `state` guard, exchanges the code, writes the three secrets to AWS, shows the Install link. `npm run setup-app [-- --org=ORG]`.
- Stack `CfnOutput`s (WebhookUrl + param/secret names) feed the tool via `cdk-outputs.json`.
- `INSTALL.md` documents the 3-step adopter journey. Sequence: `cdk deploy` → `setup-app` (create+install App) → add `runs-on:[self-hosted,mayfly]`.


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

- **Spec coverage** (`docs/superpowers/specs/2026-07-07-mayfly-design.md`): webhook 2xx-fast (T7), SQS+delay+DLQ (T6), control/provision (T10), **re-drivable idempotency** (T5 repo + T10 flow), fork-check/trust fail-closed (T10), reconciler account-safe (T11), DynamoDB correlation (T5), GitHub App auth (T3), HMAC + `isBase64Encoded` (T2/T7), MicroVM lifecycle + network connectors (T8/T9), SDK validation (T7.5), **concurrency cap + throttle-retry** (T10), **observability: DLQ/reclaim/quota alarms** (T6/T11) — all mapped.
- **Deferred by design (recorded, not gaps):** suspended warm pool (Approach C — v1 does **not** prove the warm-cost thesis), VPC-private-access network gate beyond the fork-trust boolean (v1 does **not** demonstrate fork-isolation), multi-region, multi-tenant, x86/QEMU. These are post-v1 ADRs and are stated as such, not billed as proven.
- **Integration-vs-unit honesty (revised per review):** pure logic (HMAC, JWT, fork-check, jobs claim, sweep) is TDD'd; the AWS-glue is **not** left un-covered until T12 — `microvm.ts`/`jobs.ts`/webhook/control all get **command-shape unit tests** via `aws-sdk-client-mock` (the wrapper is exactly where new bugs live), and the JS SDK itself is validated live at T7.5 **before** control.ts depends on it. T12 is the end-to-end live re-verification, not the first time the SDK path runs.
