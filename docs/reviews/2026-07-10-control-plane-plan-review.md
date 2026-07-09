# Pre-build Review — Mayfly Control Plane Implementation Plan

- **Reviewer role:** adversarial pre-build review (correctness, architecture, security, decomposition, honesty)
- **Date:** 2026-07-10
- **Under review:** [`docs/superpowers/plans/2026-07-10-mayfly-control-plane.md`](../superpowers/plans/2026-07-10-mayfly-control-plane.md)
- **Held against:** design spec `2026-07-07-mayfly-design.md`, findings `2026-07-09-mayfly-microvm-findings.md`, JIT research `github-actions-jit-runners.md`, and the verified spike (`spike/phase2-aws/run-spike-aws.sh`, `app/launcher/main.go`).

## Verdict: **build-with-changes**

The plan is well-organized, the TDD-first decomposition of pure logic is genuinely good, and the spec→task coverage map is honest about deferrals. But there is **one correctness bug that will leak or duplicate MicroVMs** (idempotency is in the wrong layer), **two omissions that will make the ported MicroVM client simply not work** (network connectors; SDK-package existence never validated before it's depended on), and a set of partial-failure / safety-cap / observability gaps. None are fatal to the architecture; all are cheap to fix in the plan now and expensive to discover at the Task 12 live deploy. Fix the five items in "Top fixes" before writing code.

---

## 1. Architecture correctness

The webhook → SQS → control-Lambda → reconciler shape is the correct, reference-validated pattern (matches `github-actions-jit-runners.md` §6). The problems are in *where* responsibilities are placed.

### 1a. `claimJob` in the webhook is the wrong layer — and it's a correctness bug, not just latency (BLOCKER)
Task 7 does idempotency via `claimJob` **in the webhook, before the 2xx**. Task 5 defines `claimJob` as a one-shot `attribute_not_exists(jobId)` conditional put. Three problems, in ascending severity:

1. **Latency/coupling (minor):** it puts a DynamoDB round-trip on the fast path and couples the "return 2xx immediately" guarantee to DynamoDB availability. The reference webhook (research §6, philips-labs) touches no database — verify sig, filter, enqueue, ack. Deviating here buys nothing.
2. **It dedupes the wrong thing (major):** the webhook claim only collapses duplicate *webhook* deliveries. The real duplicate source is **SQS at-least-once redelivery to the control Lambda**. Since the control Lambda (Task 10) has **no idempotency guard**, a control invocation that crashes/ times out *after* `runMicrovm` but *before* `putJob` will have its SQS message redelivered after the 300s visibility window and will **launch a second MicroVM for the same job.** The plan's own risk list ("two MicroVMs for one job") is unmitigated. Idempotency must live in the control Lambda, as a claim transactionally bound to the launch decision.
3. **One-shot claim with no release ⇒ stuck jobs (major):** if provisioning fails after the claim exists, the record persists and blocks all future retries of that `jobId` (`claimJob` returns false forever). A legitimate GitHub redelivery of `queued` is then dropped and the job is **stuck queued forever** with no runner. Idempotency needs a small state machine (`claimed → provisioning → running → done/failed`) that a retry can re-drive, not a permanent boolean gate.

**Fix:** webhook = verify/filter/enqueue/2xx only (no DynamoDB). Move the claim into the control Lambda; make it a conditional state transition that a redelivery can safely re-enter, and that a failed launch resets/advances rather than permanently blocks.

### 1b. Control Lambda holding the SQS invocation through `waitRunning` — acceptable for v1
Holding the invocation ~30–60s while polling `get-microvm` to `RUNNING` is fine at article scale: well under the 15-min Lambda ceiling and the 300s SQS visibility timeout (Task 6). The control Lambda correctly does **not** wait for the job to finish (it hands off JIT and returns), so lifetime is ~60–90s. Two caveats:
- You pay Lambda GB-s to sit and poll — wasteful but negligible at this scale.
- The wall-clock hold *widens the redelivery-duplicate window* in 1a; that's an argument for fixing idempotency, not for changing the transport.

**Step Functions / callback:** materially cleaner (no idle billing, native retry/timeout, a `waitForTaskToken` hand-off), but it is not required for v1 and adds infra surface. A short poll is fine **provided 1a is fixed.** Record SFN as the natural v2 refactor when the warm pool (Approach C) lands, since resume/suspend orchestration will want it anyway.

---

## 2. Correctness / AWS-fidelity gaps vs the verified spike

### 2a. Network connectors are missing from `runMicrovm` — the runner cannot reach GitHub (BLOCKER)
The spike's `run-microvm` call passes `--ingress-network-connectors "$NC:ALL_INGRESS" --egress-network-connectors "$NC:INTERNET_EGRESS"` with `NC=arn:aws:lambda:<region>:aws:network-connector:aws-network-connector`. Task 8's `runMicrovm(imageArn)→{microvmId,endpoint}` **omits network connectors entirely.** Without `INTERNET_EGRESS` the runner cannot long-poll GitHub and no job runs; without ingress the L7 JIT hand-off can't land. This is the single most load-bearing argument to `run-microvm` and it's absent from the signature and description. Must be ported verbatim.

### 2b. `@aws-sdk/client-lambda-microvms` is assumed to exist and work — never validated before it's depended on (BLOCKER-risk)
The spikes proved the **CLI/HTTP API** (`aws lambda-microvms`, current CLI ~2.28+). They did **not** prove the **JS SDK v3 client**. The plan assumes the package exists with `RunMicrovmCommand` / `GetMicrovmCommand` / `CreateMicrovmAuthTokenCommand` / `ListMicrovmImagesCommand` / `GetMicrovmImageCommand` / `TerminateMicrovmCommand`, and only exercises any of it live at Task 12 (the last task). For a service GA'd 2026-06-22 this is a real dependency risk — the JS client may lag the CLI, have different command/shape names, or not be published. The design spec's own Risk #2 anticipated "L1 `Cfn*` or a Lambda-backed custom resource" precisely because SDK/CDK maturity was uncertain; the plan quietly assumes plain SDK and never verifies it.

**Fix:** add an early, tiny task (before Task 8) that installs `@aws-sdk/client-lambda-microvms`, pins a version, and runs a throwaway TS script porting the spike's run/get/authToken/terminate against Tokyo. If the client is absent or incomplete, fall back to raw SigV4 calls or a custom-resource — decided *before* control.ts is built, not discovered at Task 12.

### 2c. Partial-failure teardown is under-specified (major)
Task 10 asserts only that a **failed `postJit` triggers `terminate`**. But the spike's cleanup trap terminates on *every* abandoned path. The plan must terminate the MicroVM if it was launched but not successfully handed off + recorded, at each stage: `waitRunning` reaching `CREATION_FAILED` or timing out, `authToken` failure, `generateJitConfig` failure, `putJob` failure. Wrap launch→record in try/finally so any exit that isn't "recorded + handed off" terminates the VM. Also: `waitRunning` must **detect the terminal `CREATION_FAILED` state and stop** (findings call this out explicitly) rather than polling 60× to timeout.

### 2d. `create-microvm-auth-token` details (minor, easy to miss)
Spike calls it with `--expiration-in-minutes 60 --allowed-ports '[{"allPorts":{}}]'` and reads `.authToken["X-aws-proxy-auth"] // .authToken`. And every endpoint call sends **two** headers: `X-aws-proxy-auth: <tok>` **and** `X-aws-proxy-port: 8080`. Task 8's "header shape" unit test must cover the port header too — it's not just the auth header. Port these exactly.

### 2e. `--hooks` trap does not translate to the SDK, but the lesson does (informational)
The `--hooks` 403 was a **CLI shorthand** artifact; the JS SDK passes structured input so the shorthand can't occur. The real lesson (build hooks are optional; don't pass them; runtime endpoint traffic flows without a `/run` hook) still holds. Just don't set hooks in `RunMicrovmCommand`. Fine to note this so nobody re-adds hooks "to be safe."

### 2f. Region pinning — verify it's per-client, not per-env (minor)
Global constraints say "every AWS call pins region." Make sure each SDK client is constructed with `region: config.region` (Tokyo), not relying on the Lambda's ambient region. The findings' "default-region clobber silently sent a `list` to the wrong region" is exactly this failure. Add a client-construction assertion.

### 2g. MicroVM image lifecycle is outside IaC (note the honesty gap)
Task 12 builds the image via `build-image.sh` (CLI), not CDK. That's pragmatic, but it contradicts the spec's "`cdk deploy` reproduces it (incl. any custom-resource glue)." Acceptable for v1 if ledgered, but state plainly in the plan that the image is a manual/scripted step outside the stack, not CDK-managed.

---

## 3. Reliability / idempotency

### 3a. Duplicate MicroVMs — see 1a. This is the headline reliability defect.

### 3b. `completed`-before-provisioned race is unhandled (major)
Fast job path: `queued` → control starts launching (60–90s) → job somehow completes/cancels → `completed` webhook → teardown handler `getJob(jobId)` finds **no `microvmId` yet** (control hasn't `putJob`'d) → cannot terminate → control finishes, hands JIT to a MicroVM whose job is already gone → **orphan.** The plan never discusses this ordering. It's survivable *only* via the reconciler, which raises the stakes on §3c. At minimum, document the race and make the reconciler explicitly responsible for "MicroVM running, no live job."

### 3c. Reconciler orphan detection is not clearly race-safe or account-safe (major)
- **Account-safety:** `listActive()` (Task 8/11) lists MicroVMs via the service API. How does it distinguish *Mayfly* MicroVMs from any other MicroVM in Tokyo? If it terminates every active VM not in the table, it will nuke unrelated workloads. The global "Tag everything `project=mayfly`" constraint is **not wired into MicroVM launch or list** — `runMicrovm` must tag the VM and `listActive` must filter by tag. This must be explicit in Tasks 8/11.
- **Race-safety:** a VM just launched by control but not yet `putJob`'d looks orphaned. The two-phase mark-then-sweep (grace = one 2-min cycle) mitigates *iff* provisioning always completes inside one cycle — control is ~60–90s, so it's borderline but OK. Make the grace window explicitly ≥ max provisioning time with margin (e.g., 2 cycles), and key the `firstSeenOrphan` marker by `microvmId`.
- The `firstSeenOrphan` marker needs its own keyspace/design in DynamoDB; Task 11 hand-waves "track a marker." Specify the item shape.

### 3d. Idempotency of `generate-jitconfig` name (minor, folded into 1a)
`generateJitConfig(name=jobId)` — runner names must be unique per repo. An SQS redelivery would re-mint with the same name, another duplicate vector. Fixing 1a covers it.

---

## 4. Security

### 4a. Function URL body decoding — a real bug waiting at Task 7 (major)
Function URL (and API GW) may deliver the body **base64-encoded** (`event.isBase64Encoded === true`). HMAC must be computed over the **raw decoded bytes**. Task 7 says "parse raw body" but never mentions `isBase64Encoded`. If unhandled, either every signature fails, or you verify over the wrong bytes. Add explicit base64 handling and a test with an encoded body.

### 4b. Function URL auth NONE + HMAC — acceptable, with caveats
Standard GitHub webhook pattern; `hmac.ts` correctly uses `timingSafeEqual` and length-checks. Caveats: the endpoint is publicly invocable, so unauthenticated spam still costs Lambda invocations (HMAC rejects but you pay). Add **reserved concurrency / throttling** on the webhook Lambda as a cheap DoS/cost bound. cdk-nag will flag auth NONE — a justified suppression is fine.

### 4c. Fork-PR handling — deferring the network gate is acceptable *only* because v1 has no private resource (but be honest)
The spec lists as a **success criterion**: "an untrusted (fork) job is **denied private-VPC access** while a trusted job reaches the demo resource." Task 10 defers the network profile and merely records `trust:'fork'`. Since v1 launches every VM with `INTERNET_EGRESS` and **no** private-VPC SG at all, fork and internal jobs get the identical network profile — so nothing is leaked (there's nothing to leak into), but the fork-check is **inert/decorative** and the spec's headline security demo is **not delivered in v1.** That's a defensible v1 cut, but the plan should state plainly: (i) v1 does not demonstrate the trust-gate value prop, and (ii) the `isForkPR` path is unexercised by any real network consequence, so it must at least be unit-tested against real fork/non-fork run payloads or it will rot before Approach C needs it.
- **Fail-closed default (must specify):** if the `getRun` fork-check API call fails, the plan doesn't say what happens. It must **fail closed** (treat as untrusted). Add this to Task 10.
- Note also: v1 *does* provision a full MicroVM with internet egress for hostile fork code. That's the same exposure as any self-hosted runner, mitigated by the microVM boundary — fine for a PoC, but call it out.

### 4d. IAM `lambda-microvms:*` is not least-privilege (major)
Task 10 says "IAM for `lambda-microvms:*` (scoped)" — `:*` is the opposite of scoped, and cdk-nag will flag it (so the plan will "suppress," which defeats the stated least-priv gate). Enumerate the actual actions: `RunMicrovm`, `GetMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken`, `ListMicrovmImages`, `GetMicrovmImage`, plus permission to use the network-connector ARN. Resource-level scoping is hard (VM ARNs are runtime-created), so at least condition on tag `project=mayfly` where the API supports it, and split per-Lambda (webhook needs none of these). Same for secrets: webhook reads only the SSM webhook secret; control reads only the Secrets Manager app key — grant each Lambda its own, not a broad "SSM read."

---

## 5. Decomposition / testability

### 5a. The unit/integration split is partly a dodge (major)
The plan TDD's the pure logic (HMAC, JWT, fork-check, jobs, sweep) well. But it leaves the **two highest-risk surfaces** — `microvm.ts` (Task 8) and the `github.ts` fetch calls (Task 3) — with **zero automated coverage until the single live run at Task 12.** The rationalization ("thin SDK wrapper over a proven flow") is weak: the flow was proven in **bash/CLI**, not the TS SDK, so the wrapper is exactly where new bugs live (command names, input shape, network-connector params, auth-token parsing, base64 body). And the plan is inconsistent — it *does* use `aws-sdk-client-mock` for DynamoDB (Task 5) but declines to for the MicroVM/SQS clients.

**Fix:** use `aws-sdk-client-mock` in Task 8 to assert `runMicrovm` issues `RunMicrovmCommand` with the correct input (image ARN, both network connectors, **no** idle policy, `maximumDurationInSeconds`, tags), `terminate` issues `TerminateMicrovmCommand`, auth-token parsing handles the `X-aws-proxy-auth` shape. Cheap, catches the param bugs before Task 12. Same for the `github.ts` fetch calls via a mocked `fetch`.

### 5b. Task 12 is an overloaded mega-task (major)
Task 12 bundles: deploy + set secrets + create/point GitHub App + build image + live e2e + teardown + ledger. If anything in the untested §5a surface is wrong, it all surfaces at once with poor isolation. Split out (a) the early SDK-probe (see 2b) and (b) a "deploy stack + smoke one MicroVM run via the deployed control Lambda, no GitHub" checkpoint before the full GitHub-driven e2e. Incremental integration beats one big-bang.

### 5c. Dependency ordering — mostly fine
Phase ordering is sound; no task blocks on an unbuilt internal dependency **except** Task 8's dependence on the unproven external SDK (2b) — which is why the SDK probe must move earlier. Task 9 (image) is independent and can parallelize.

---

## 6. Scope

### 6a. v1 proves none of the spec's headline claims (honesty gap, not over/under-build)
v1 = Approach B (per-job launch), correctly scoped as the de-risking baseline. But the spec's **core measurable claim is warm-start-at-zero-idle-cost via suspend/resume (Approach C)**, and its security success-criterion is the fork isolation demo (deferred, §4c). So v1 is a **plumbing milestone that backs neither the article's central number nor its security demo.** The plan bills itself "article-first" — that's in tension with shipping the non-differentiator first. This is the right *engineering* sequence (B before C), but the plan should say explicitly: **v1 alone does not support the article; Approach C is required for the thesis.** Not over-built.

### 6b. Missing: safety concurrency cap (major)
Spec calls for a "max pool/concurrency cap → bounded blast radius + cost." The plan has **no cap** on concurrent MicroVMs / control-Lambda concurrency. A matrix job (50 jobs) → 50 simultaneous `RunMicrovm` calls against the **~5 TPS** limit (findings) → throttling and unbounded cost. Add reserved concurrency on the control Lambda and/or a max-in-flight guard, plus retry/backoff for RunMicrovm throttling.

### 6c. Missing: observability, DLQ alarm, quota metric (major)
The spec makes observability "first-class" and the reconciler "the backbone," yet there is **no task** for metrics/alarms. At minimum for v1: an alarm on **DLQ depth > 0** (Task 6 adds a DLQ but nothing watches it — failed jobs die silently, possibly after launching a VM), a metric/count on **reconciler terminations** (leaked-VM reclaims), and the **GitHub API quota-remaining** metric the research doc flags. Without these, a leak or a stuck webhook is invisible. Add an observability task.

---

## Spec-coverage cross-check (what the plan's self-review omits)
The plan's self-review claims full spec mapping. Not quite:
- **Safety concurrency cap** (spec SRE §"Safety rails") — absent (§6b).
- **Observability / metrics** (spec SRE §Observability; research §8) — absent (§6c).
- **Trust→network gate** (spec Architecture §5, Success criteria) — deferred and inert in v1; the self-review lists it "mapped (T10)" but T10 only records a boolean (§4c).
These belong in the "Deferred by design" list or as new tasks — not silently under "mapped."

---

## Top fixes before writing code
1. **Move idempotency out of the webhook into the control Lambda** as a re-drivable state transition bound to the launch, and give the control Lambda a redelivery guard — closes the duplicate-MicroVM bug and the stuck-job livelock (§1a, §3a, §3d). Webhook becomes verify/filter/enqueue/2xx only.
2. **Port the network connectors into `runMicrovm`** (ingress `ALL_INGRESS`, egress `INTERNET_EGRESS`, the `aws-network-connector` ARN) and **tag launched VMs `project=mayfly`**; make `listActive`/reconciler filter by that tag — without these the runner can't reach GitHub and the reconciler is account-unsafe (§2a, §3c).
3. **Add an early SDK-probe task** that validates `@aws-sdk/client-lambda-microvms` exists and works against Tokyo (port the spike run/get/authToken/terminate) *before* control.ts, and unit-test `microvm.ts`/`github.ts` with `aws-sdk-client-mock`/mocked `fetch` for command shape — de-risks the highest-risk surface instead of back-loading it all to Task 12 (§2b, §5a, §5b).
4. **Specify full partial-failure teardown** (try/finally terminating any launched-but-not-recorded VM at every stage; `waitRunning` detects `CREATION_FAILED`), **fail-closed fork-check**, and **handle Function URL `isBase64Encoded`** before HMAC (§2c, §4a, §4c).
5. **Add safety + observability**: reserved/max concurrency cap and RunMicrovm throttle-retry; DLQ-depth alarm, reconciler-reclaim metric, GitHub-quota metric; and enumerate least-priv `lambda-microvms` actions instead of `:*` (§4d, §6b, §6c).

## Smaller notes
- Send both `X-aws-proxy-auth` and `X-aws-proxy-port: 8080` on endpoint calls; parse the `.authToken["X-aws-proxy-auth"]` shape (§2d).
- Construct every SDK client with `region: config.region` explicitly; assert it (§2f).
- State that the MicroVM image is a scripted step outside CDK, not IaC-reproduced (§2g).
- State plainly that v1 backs neither the warm-start cost number nor the fork-isolation demo; Approach C is required for the article thesis (§6a).
