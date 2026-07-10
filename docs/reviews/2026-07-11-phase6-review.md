# Adversarial review — Phase 6 deploy runbook + governance layer

- **Date:** 2026-07-11 · **Reviewer:** control-plane pre-deploy audit (read-only, no code changed)
- **Artifact:** `docs/runbooks/2026-07-11-phase6-deploy.md`
- **Cross-checked against:** `app/infra/lib/mayfly-stack.ts`, `app/build-image.sh`,
  `app/scripts/setup-app.ts`, `app/src/lib/{manifest,config,governance,jobs,microvm,github}.ts`,
  `app/src/handlers/{webhook,control,reconciler}.ts`, `app/image/Dockerfile`, package manifests,
  `docs/findings/2026-07-09-mayfly-microvm-findings.md`, `docs/adr/0002-webhook-ingress.md`.

**Verdict: deploy-with-changes.** The runbook sequence, output keys, IAM grants, and governance are
sound, but one packaging defect will very likely make the paid live test fail *after* you have spent
money and created a MicroVM image, and two documentation/teardown gaps will mislead the operator and
leave a lingering paid resource. Fix F1–F3 before spending anything.

Legend: **[CONFIRMED]** = verified in code. **[PLAUSIBLE]** = mechanism real, outcome depends on an
external fact I could not execute (AWS runtime contents, live timing).

---

## F1 — Control & reconciler Lambdas will almost certainly crash on cold start: `@aws-sdk/client-lambda-microvms` is externalized, not bundled  ·  [CONFIRMED mechanism / PLAUSIBLE runtime-presence]  ·  **BLOCKER**

**Failure.** `control.ts` and `reconciler.ts` import `@aws-sdk/client-lambda-microvms`
(`app/src/lib/microvm.ts:1-9`). The stack builds all three Lambdas with
`bundling = { minify, sourceMap, target:'node20' }` and sets **no** `externalModules` / `bundleAwsSDK`
/ `nodeModules` (`app/infra/lib/mayfly-stack.ts:186`, `213-226`, `237-248`). I read CDK's bundler
(`app/infra/node_modules/aws-cdk-lib/aws-lambda-nodejs/lib/bundling.js`): for a non-variable Node 20
runtime the default externals are `["@aws-sdk/*"]`, and esbuild is invoked with `--external:@aws-sdk/*`.
So **every** `@aws-sdk/*` client is left as a bare `require()` resolved from the Lambda runtime, not
bundled into the artifact.

The standard clients the webhook uses (`client-sqs`, `client-ssm`) ship inside the Node 20 runtime, so
the webhook loads. But `@aws-sdk/client-lambda-microvms` is a brand-new service client (lambda-microvms
GA 2026-06-22) that is *not* part of the Node 20 runtime's frozen SDK bundle. Result: control and
reconciler throw `Cannot find module '@aws-sdk/client-lambda-microvms'` at module load, on every
invocation.

**What the operator sees (money already spent):** Step 1-3 pass, the image builds (Step 2 spends
cents + snapshot storage), the webhook 200s the `queued` event, then **nothing provisions**. Each SQS
message fails, retries 3× (queue `maxReceiveCount:3`, `mayfly-stack.ts:113`), lands in the DLQ, and
the DLQ alarm fires. No MicroVM ever runs. Step 4 fails at "Control logged … runMicrovm".

**Evidence.** `@aws-sdk/client-lambda-microvms` is present in `app/node_modules` (a real npm package,
version-pinned in `app/package.json:16`) — i.e. it is bundleable, it is simply being excluded.

**Fix (one line, removes all doubt).** Bundle the AWS SDK into the handler artifacts. In
`mayfly-stack.ts` set on the shared `bundling` object:
```ts
const bundling = { minify: true, sourceMap: true, target: 'node20', externalModules: [] };
```
(or `bundleAwsSDK: true`, or the narrower `nodeModules: ['@aws-sdk/client-lambda-microvms']`). Then
run `cd app && npm ci` **before** `cd app/infra && npm run deploy` so esbuild can resolve the packages
to bundle. Redeploy and confirm the control Lambda loads (invoke once, check no `MODULE_NOT_FOUND`).

> Note: the runbook already has `npm ci` in the app dir, but only in **Step 3** (after deploy). Move an
> `cd app && npm ci` into Step 0/1 preconditions regardless, since the bundle step reads `app/node_modules`.

---

## F2 — Step 4 verification gates check for log lines the code never emits (false confidence)  ·  [CONFIRMED]  ·  **HIGH**

**Failure.** The runbook's Step 4 "Verify the full lifecycle" tells the operator to confirm:
- "Webhook logged a **200** for the `queued` event (no 401)"
- "Control logged: claim `proceed` → `runMicrovm` → `waitRunning` → JIT hand-off → `markRunning`"

Neither is emitted. `control.ts` has **zero** happy-path logging — the only `console.*` in the file is
the quota-drop `console.warn` (`control.ts:79`). There is no log at claim, runMicrovm, waitRunning,
JIT, or markRunning. `webhook.ts` returns `{ statusCode: 200 }` but never logs it; the only
`console.log` is the rejection path (`webhook.ts:70`). Function URL access logging is not enabled.

**Consequence.** The operator watching `aws logs tail` will see Lambda `START/END/REPORT` lines and
nothing else on the success path — they cannot confirm any stage, and cannot tell *where* a stuck
pipeline stalled. This is exactly the "false confidence" the review asked about: the gate is
unsatisfiable as written, so an operator either declares success on absent evidence or thinks it's
broken when it isn't.

**Fix.** Either (a) add stage `console.log`s to `provision()` (`claim proceed`, `run <id>`,
`running <id>`, `jit ok`, `markRunning`) and a one-line 200 log in the webhook, **or** (b) rewrite the
Step 4 checklist to verifiable evidence only: webhook invocation present + no 401; DynamoDB record
transitions (`aws dynamodb get-item` shows `provisioning`→`running`→gone); `list-microvms` shows one
`RUNNING`; job `completed/success` in GitHub; DLQ depth 0. (a) is better — the log tax is trivial and
pays for itself the first time this is debugged live.

---

## F3 — Teardown does not delete the Secrets Manager secret; it lingers in the recovery window (paid + blocks re-deploy)  ·  [CONFIRMED]  ·  **HIGH**

**Failure.** Step 5 destroys the stack (`cd infra && npm run destroy` → `cdk destroy --force`) but does
**not** force-delete `/mayfly/appPrivateKey`. `cdk destroy` issues CloudFormation `DeleteSecret`
*without* `ForceDeleteWithoutRecovery`, which only *schedules* deletion with the default recovery
window (7–30 days). During that window the secret name is retained.

Two consequences the runbook gets wrong:
1. **Cost claim is off.** Line 4 says "Net footprint after teardown ≈ $0" and line 138 "only the
   standing `CDKToolkit` remains (~$0)". The secret sits in "scheduled for deletion" after destroy; you
   are not cleanly at $0 immediately.
2. **Rollback is broken.** The Rollback note (line 154) says "run Step 5 teardown, fix, re-run from
   Step 1." A re-deploy the same day re-creates `AppPrivateKey` with the same name `/mayfly/appPrivateKey`
   (`mayfly-stack.ts:133-136`) → CloudFormation `CreateSecret` fails: *"You can't create this secret
   because a secret with this name is already scheduled for deletion."* The re-deploy stalls in
   `ROLLBACK`/`CREATE_FAILED` and the operator has no obvious cause.

**Fix.** Add to Step 5, before or instead of relying on `cdk destroy` for the secret:
```bash
aws secretsmanager delete-secret --secret-id /mayfly/appPrivateKey \
  --force-delete-without-recovery --region ap-northeast-1 || true
```
Run it *after* `npm run destroy` (destroy schedules it; this purges it), or add it as an explicit
pre-destroy step. Also correct the cost line to note the secret is purged immediately via
`--force-delete-without-recovery` (otherwise it lingers up to 30 days).

---

## F4 — Over-quota "drop after maxRequeues" is a silent data-loss path (no DLQ, no alarm, no metric)  ·  [CONFIRMED]  ·  **MEDIUM**

**Failure.** When an owner is over quota for more than `maxRequeues` (default 5) cycles, `provision()`
logs a `console.warn` and `return`s (`control.ts:79-82`). Because it returns (does not throw), SQS
considers the message handled and deletes it. The GitHub job stays `queued` forever (no runner ever
registers, no teardown), and there is **no** DLQ entry, **no** alarm, and **no** CloudWatch metric —
unlike the two failure paths that *are* observable (DLQ alarm `mayfly-stack.ts:144-153`, reclaim metric
+ alarm `155-167`). The only trace is a log line nobody is tailing.

**Test impact:** none. Default `perOwnerConcurrency=10` and the live test launches one job for
`mikeng-io`, so `countActiveByOwner` returns 0 and this branch is never hit. This is a **production
footgun**, not a Step 4 blocker. The runbook's failure table ("stuck `queued` … requeue budget spent →
raise `perOwnerConcurrency`") acknowledges the symptom but not that it is *silent*.

**`attempts` bound is correct.** Traced: first over-quota sets `attempts=1` (requeue), … `attempts=5`
(requeue), `attempts=6` → `6 <= 5` false → drop. 5 requeues × 60 s ≈ 5 min backpressure, then drop. No
infinite loop; the bound behaves as intended.

**Fix.** On drop, emit a CloudWatch metric (e.g. `QuotaDropped`) with an alarm, or route the message to
the DLQ deliberately (throw a typed error / `sqs:SendMessage` to the DLQ) so the existing DLQ alarm
covers it. At minimum, add a runbook note that an over-quota drop is currently silent.

---

## F5 — Per-owner quota is soft: GSI eventual consistency + non-atomic check across concurrent invocations  ·  [PLAUSIBLE]  ·  **MEDIUM**

**Mechanism.** `countActiveByOwner` runs two `QueryCommand`s against the `state-index` GSI
(`jobs.ts:141-144`, `46-57`). GSIs are **eventually consistent** — a just-written `provisioning`
record may not yet be visible — and the control Lambda runs up to `reservedConcurrentExecutions: 5`
copies concurrently with `batchSize: 1` (`mayfly-stack.ts:221`, `227`). Two provisions for the same
owner can both read `active < perOwnerConcurrency` and both proceed, so an owner can transiently exceed
its cap. `beginProvisioning`'s conditional write (`jobs.ts:76-95`) still prevents **double-provisioning
the same job** (verified: second delivery gets `skip`), so this is a quota *overshoot*, not a
correctness break. Also: `listByState`/`countActiveByOwner` do not paginate `QueryCommand`
(`LastEvaluatedKey` ignored), so beyond ~1 MB of active records both the quota count and the reconciler
sweep silently undercount.

**Test impact:** none (single job). Flagged for production hardening.

**Fix.** Accept overshoot as documented soft-limit behavior (fine for v1), and add pagination to
`queryByState` before multi-tenant load. A hard cap would need a conditional counter/atomic decrement,
not a GSI scan.

---

## F6 — `build-image.sh` empty-array expansion under `set -u`  ·  [PLAUSIBLE, low]  ·  **LOW**

`read -r -a HOOKS_ARGS <<< "${MAYFLY_HOOKS_ARGS:-}"` then `"${HOOKS_ARGS[@]}"`
(`build-image.sh:44,51,57`) expands an empty array under `set -euo pipefail`. Safe on bash ≥4.4;
errors "unbound variable" on stock macOS bash 3.2. **This machine runs bash 5.3.9** (checked), so the
default (no-hooks) path is fine here. If the script may run on a stock-bash macOS, guard with
`${HOOKS_ARGS[@]+"${HOOKS_ARGS[@]}"}`. Not a blocker on the target host.

---

## Things the runbook gets RIGHT (verified — de-risking the deploy)

- **F0a — Output-key drift: NONE. [CONFIRMED clean]** Every `CfnOutput` id in `mayfly-stack.ts:290-295`
  (`WebhookUrl`, `WebhookSecretParamName`, `AppIdParamName`, `AppKeySecretName`, `ArtifactBucketName`,
  `BuildRoleArn`) exactly matches the keys read by `build-image.sh:21-22`
  (`.MayflyStack.ArtifactBucketName`, `.BuildRoleArn`) and `setup-app.ts:48-51` (`out.WebhookUrl`,
  `out.WebhookSecretParamName`, `out.AppIdParamName`, `out.AppKeySecretName`). No silent break here.
- **F0b — Governance will NOT block the test. [CONFIRMED]** Defaults `allowedOwners=['mikeng-io']`,
  `allowAll=false` (`mayfly-stack.ts:82,84`). `isAllowed('mikeng-io','mayfly-test', …)` matches on
  owner (case-insensitive, `governance.ts:23-28`) → served. Fail-closed default is correct, and the
  runbook (lines 84-86) correctly warns that a *different* owner (e.g. `nortrix-labs`) is silently
  rejected (webhook returns 200 "not authorized", `webhook.ts:69-72`) unless `allowedOwners` is updated
  and redeployed first.
- **F0c — IAM is complete for the happy path. [CONFIRMED]** Control: SQS send for requeue
  (`grantSendMessages`, line 228) + SQS consume (event source) + `MICROVM_ACTIONS` covering
  Run/Get/Terminate/List/CreateAuthToken/ListImages (lines 21-29, 232-234, all used by `microvm.ts`) +
  DynamoDB RW incl. GSI (`grantReadWriteData`, line 229) + `ssm:GetParameter` on appId
  (`appIdParam.grantRead`, 230) + `secretsmanager:GetSecretValue` on the key (`appPrivateKey.grantRead`,
  231). Reconciler: microvm actions + `cloudwatch:PutMetricData` (line 254) + DynamoDB RW. Webhook:
  SSM read (line 202) + SQS send (line 201). Nothing missing.
- **F0d — Secret type mismatch is benign. [CONFIRMED]** `appId`/`webhookSecret` are created as SSM
  `String` (`mayfly-stack.ts:118-127`), written back as `String`/`Overwrite` (`manifest.ts:92-107`), and
  read via `getSecret(..., WithDecryption:true)` (`config.ts:69-75`). SSM ignores `WithDecryption` on a
  plain `String` — no error, no 401. *Security smell only:* the webhook HMAC secret and appId sit in
  **plaintext** SSM, not SecureString (out of scope for "will the deploy work", worth a follow-up).
- **F0e — build-image staging matches the Dockerfile. [CONFIRMED]** The script stages
  `runtime/launcher/main.go` and zips `Dockerfile runtime` (`build-image.sh:33-38`); the Dockerfile's
  `COPY runtime/launcher/main.go .` (`Dockerfile:12`) resolves against that layout. The lean `runner`
  stage is genuinely LAST (`Dockerfile:43-46`), so AWS's "build the final stage" makes it the default
  target as claimed. The `/ready` hook uncertainty is flagged honestly in both the script (41-43) and
  runbook (61-64), consistent with the findings doc's "`--hooks` shorthand → bogus 403" note.
- **F0f — Directory sequencing is executable.** Step1 `cd app/infra`; Step2 `cd ../` → `app/`; Step3
  stays in `app/` (`npm run setup-app` resolves to `app/package.json:11`); Step5 `cd infra` from `app/`.
  All paths line up. `installationId` SSM param stays `REPLACE_ME` forever but is unused on the happy
  path (webhook/control take `installationId` from the event/message) — harmless.

---

## Secondary notes (not blockers)

- **Runner image can't do Docker/`services:`.** The image built is the lean `runner` target (non-root,
  no `dockerd`, and `runMicrovm` passes no `--additional-os-capabilities`, `microvm.ts:76-92`). The
  findings doc validated Docker/`services:` only on the **`docker`** target with `["ALL"]` caps. If the
  Step 4 test workflow uses `docker build/run` or `services:`, it will fail. A plain
  `runs-on: [self-hosted, mayfly]` job that just runs shell/`setup-*` steps is fine — make sure the test
  workflow is that.
- **Reconciler checkbox is slightly misleading.** Step 4's "No orphan after the 2-min reconciler sweep"
  reads as if the sweep is the cleanup. It isn't: the reconciler only reaps VMs overdue by
  `maxRuntimeSeconds` (3600 s default) + 120 s grace (`reconciler.ts:39,57-63`). For a healthy job,
  teardown deletes the record and the sweep finds nothing. Fine, but don't expect the sweep to clean a
  just-completed job.
- **Webhook module-caches the secret** (`webhook.ts:8,36`). If `WebhookFn` is ever invoked *before*
  `setup-app` writes the real secret, a warm container caches `REPLACE_ME` and 401s until it recycles.
  The runbook's deploy→setup-app→test order avoids this; just don't hand-invoke the webhook between
  Step 1 and Step 3.
- **Control Lambda timeout is tight but adequate:** 180 s (`mayfly-stack.ts:219`) vs. `waitRunning`
  120 s (`microvm.ts:95`) + auth/JIT/HTTP + throttle backoff. Leaves ~40-50 s headroom; acceptable.

---

## Must-fix before spending money
1. **F1** — bundle `@aws-sdk/client-lambda-microvms` (`externalModules: []` or `bundleAwsSDK: true`) and
   `cd app && npm ci` before deploy, or control/reconciler crash and the paid test yields zero VMs.
2. **F2** — fix the Step 4 log-based gates (add stage logs, or rewrite gates to DynamoDB/list-microvms
   evidence) so you can actually tell success from a stall.
3. **F3** — add `aws secretsmanager delete-secret … --force-delete-without-recovery` to Step 5; correct
   the "$0 after teardown" claim and the same-day re-deploy rollback path.
4. **F4** — make the over-quota drop observable (metric+alarm or DLQ) before production; harmless for
   this test.
</content>
</invoke>
