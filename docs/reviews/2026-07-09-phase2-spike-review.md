# Phase 2 AWS MicroVM spike — adversarial pre-run review

**Date:** 2026-07-09
**Reviewer:** adversarial code review (pre-run, real AWS, costs money)
**Scope:** `spike/phase2-aws/` (launcher, Dockerfile, build-image.sh, run-spike-aws.sh, CDK infra, README)
**Goal under test (Unknown #2):** does a real Lambda MicroVM stay RUNNING while the GitHub
runner long-polls (outbound-only) and executes one job, with the JIT config handed over the L7
endpoint (`X-aws-proxy-auth`)?

## Verdict: FIX-FIRST

The AWS API surface is **mostly correct** — I cross-checked every uncertain flag against the live
docs (`docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html`,
`.../microvms-images.html`, `.../microvm-api/API_RunMicrovm.html`) and the network-connector ARNs,
idle-policy shape, auth-token parsing, endpoint URL usage, and `create-microvm-auth-token` args are
all right. But there are **three issues that mean the spike as written cannot honestly answer
Unknown #2**, plus a **build-failure detection bug that will silently waste a ~20 min build cycle**,
plus **money/orphan gaps**. None are "blocked" (nothing is fundamentally impossible), but do not run
it as-is — it can produce a green "PASS" that proves nothing, and it can leak a running MicroVM.

Money risk is **bounded** by `--maximum-duration-in-seconds 14400` (Lambda force-terminates after 4h)
and the EXIT trap, so worst-case orphan cost is one MicroVM for ≤4h — real but not catastrophic.

---

## What is CORRECT (verified against live docs — do not "fix" these)

- **Endpoint URL:** `endpoint` in the RunMicrovm response is a **bare hostname**; docs use
  `https://${endpoint}/health`. The script's `https://$EP/...` is correct — no double-scheme bug.
- **Auth token parse:** docs show `token_resp["authToken"]["X-aws-proxy-auth"]`. The script's
  `jq -r '.authToken["X-aws-proxy-auth"] // .authToken'` is correct.
- **Network connectors:** the `arn:...:network-connector:aws-network-connector:ALL_INGRESS` /
  `:INTERNET_EGRESS` string form matches the docs example exactly.
- **Idle policy shape:** `{autoResumeEnabled,maxIdleDurationSeconds,suspendedDurationSeconds}` is exact.
- **`create-microvm-auth-token`:** `--allowed-ports '[{"allPorts":{}}]'`, `--expiration-in-minutes`,
  `X-aws-proxy-port` default 8080 — all correct.
- **`--maximum-duration-in-seconds 14400`:** within the valid 1–28,800 range.
- **`--execution-role-arn` is genuinely NOT needed.** It's optional; the runner only talks outbound
  to GitHub, needs no AWS services. Not creating one in CDK is correct.
- **Lifecycle hook paths + CMD:** hooks are `/aws/lambda-microvms/runtime/v1/<name>`; the build
  "Launches your application using the ENTRYPOINT or CMD instruction." So the launcher's mux routes
  and the Dockerfile `CMD` are both fine. The launcher registers run/resume/suspend/terminate/ready/
  validate — the full set (runtime + build hooks).
- **`get-microvm-image --image-identifier <NAME>`:** docs use the image name as `--image-identifier`
  elsewhere, so querying by `IMAGE_NAME` is accepted.
- **`base-image-arn arn:aws:lambda:<region>:aws:microvm-image:al2023-1`:** matches docs.

---

## Findings, ranked by severity

### S1 (HIGH, experiment-invalidating) — Polling `/status` over the endpoint confounds the test

The watch loop hits `https://$EP/status` **every 10 s**. Per the docs, *"the presence of traffic
through the MicroVM's endpoint signals activity"* and resets the idle timer; and with
`autoResumeEnabled:true` any endpoint request to a suspended VM **auto-resumes it** (Lambda holds the
request during resume). So the observer itself supplies inbound traffic every 10 s → the idle timer
can never reach `maxIdleDurationSeconds` → **the MicroVM cannot idle-suspend while being watched.**

This is a Heisenberg flaw: the act of measuring job progress via the endpoint prevents the exact
failure mode (outbound-only → idle suspend) that Unknown #2 is about. `STAYED_RUNNING=YES` is
therefore near-guaranteed and proves nothing about the outbound-only hazard.

**Fix:** during the idle window, observe **only** via the control-plane `get-microvm --query state`
(that is NOT endpoint traffic). Do not poll `/status` over the endpoint while you're trying to
observe idle behavior. Poll `/status` at most once at the very end (or accept that it will resume the
VM). Better: read job completion from GitHub's API + the runner's CloudWatch logs, not the endpoint.

### S2 (HIGH, experiment-invalidating) — `maxIdleDurationSeconds:3600` makes a PASS trivially true

Even without S1, the idle threshold (1 h) dwarfs a smoke-job's runtime (~30–120 s). The VM would
never suspend within the ~400 s watch window regardless of the outbound-only concern. So the test
**can only pass** on the idle axis; it cannot exhibit the failure it's meant to probe.

To actually answer Unknown #2 you need two runs (or one deliberately-hostile run):
- **Prove the hazard exists:** `maxIdleDurationSeconds` low (e.g. 30–60), `autoResumeEnabled:false`,
  a workflow step that `sleep`s longer than the idle window, observe via `get-microvm` only (per S1),
  and show the VM goes `SUSPENDING/SUSPENDED` mid-job and the GitHub run fails.
- **Prove the mitigation:** disable auto-suspend or set a `maxIdleDurationSeconds` ≥ your worst-case
  job, same control-plane-only observation, show state stays `RUNNING` and the run succeeds.

As written it does neither; it just sets idle so high the question is dodged. This is fine as a
"does my intended production config hold up" smoke test, but it is **not** evidence about the
underlying auto-suspend behavior — the RESULT.md should not claim it answers Unknown #2 without S1+S2
fixed.

### S3 (HIGH, wastes a build cycle) — Wrong image failure-state string; build failures go undetected

`build-image.sh` polls for `CREATED` / `CREATE_FAILED`. The live docs give the **image state** enum
as `CREATING, CREATED, CREATION_FAILED, UPDATING, UPDATED, UPDATE_FAILED, ...` — the failure value is
**`CREATION_FAILED`**, not `CREATE_FAILED`. A failed build therefore never matches the failure case;
the loop spins the full 80×15 s = **20 minutes**, then falls through and prints an empty/`None`
`imageArn`, and you proceed to `run-spike-aws.sh` with a bad ARN. (The task's "verified facts" listed
`CREATE_FAILED`; the live docs disagree — trust the docs.)

Compounding: there are now **three independent states**. To run a MicroVM you need image state
`CREATED`/`UPDATED` **AND** version state `SUCCESSFUL` **AND** version `ACTIVE`. The docs explicitly
warn *"an image in the CREATED state can contain a version whose state is FAILED."* The script checks
only image state, so it can green-light a CREATED image whose build actually failed → `run-microvm`
returns `ResourceNotFoundException` ("image ... not in CREATED state").

**Fix:** match `CREATION_FAILED` (and `UPDATE_FAILED`); accept `CREATED` **or** `UPDATED` as success;
and verify the latest version state is `SUCCESSFUL`/`ACTIVE` before running. On timeout, exit non-zero.

### S4 (HIGH, likely first-run build hang/race) — `create-microvm-image` configures no `/ready` hook or hook port

The docs: the build *"Waits for initialization to complete, signalled by your lifecycle hook,"* and
*"If you configure any hooks, you must specify the port that your application listens on for hook
requests."* `build-image.sh` passes **no** hook configuration and **no** hook port. The launcher
serves `/ready` and `/validate`, but the build was never told to call them or on which port — so the
`/ready` handshake the launcher implements is dead code, and the snapshot timing relative to the
launcher's `ListenAndServe` is undefined (the snapshot can be taken before `:8080` is bound).

**Fix:** configure the build hook port (8080) and the `/ready` hook in `create-microvm-image`
(and ideally `/validate`), so Lambda snapshots only after the launcher answers `/ready` 200. Confirm
the exact flag names via `aws lambda-microvms create-microvm-image help` (e.g. a `--hooks` /
`readyTimeoutInSeconds` shape) — this is the one create flag I could not pin to an exact CLI spelling.

### S5 (MEDIUM, money/orphan) — EXIT trap doesn't cover SIGINT/SIGTERM

`trap '... terminate-microvm ...' EXIT` does **not** fire on Ctrl-C or `kill` in bash unless those
signals are also trapped. A Ctrl-C during the ~7 min watch loop leaves a **running MicroVM billing**
until the 4 h max-duration backstop.

**Fix:** `trap '...' EXIT INT TERM`. Also idempotency-guard the handler (it can run twice).

### S6 (MEDIUM, silent staleness) — Re-running `build-image.sh` reuses the OLD snapshot

`create-microvm-image` for an existing name will `ConflictException`; the script swallows it
(`|| { echo ... }`) and then polls/uses the **pre-existing** image. There is a separate
`update-microvm-image` API (requires `--base-image-arn` + `--build-role-arn` every time) that the
script never calls. So iterating on `main.go`/`Dockerfile` and re-running **will not pick up your
changes** — you'll test a stale snapshot and not know it. The README explicitly anticipates iteration
(e.g. switching the base image), so this will bite.

**Fix:** detect "already exists" and call `update-microvm-image` (new code artifact) instead, or
delete-then-create. Fail loudly if create errors for any other reason.

### S7 (MEDIUM, false GitHub correlation) — `runs?per_page=1` grabs the wrong run

`actions/runs?per_page=1` returns the newest run for the **whole repo**. After
`workflow_dispatch` there's a lag before the run is created, so early polls (and the "final GitHub
run" line) can read a **previous** run's `success`/`failure` — a false pass or false fail unrelated to
this MicroVM.

**Fix:** filter by the workflow and by a post-dispatch timestamp, e.g.
`actions/workflows/mayfly-spike.yml/runs?created=>=<iso>&per_page=1`, or correlate on the JIT runner
name. Also poll until a *new* run appears rather than trusting `[0]` immediately.

### S8 (MEDIUM, false "stayed RUNNING") — `PENDING` counted as healthy; no assertion of `RUNNING` reached

`STAYED_RUNNING` only flips to 0 when state is neither `RUNNING` nor `PENDING`. A VM stuck in
`PENDING` (never booted, e.g. launcher never started) reports **"stayed RUNNING throughout: YES."**
And the final `PASS = ...` line is a static `echo` — the script never actually asserts pass/fail; a
human must eyeball three separate outputs.

**Fix:** require the VM to reach `RUNNING` at least once; treat "never reached RUNNING" and
"job not done at loop end" as FAIL; compute and print an explicit PASS/FAIL with a non-zero exit on
FAIL.

### S9 (MEDIUM, hangs) — no `--max-time` on any `curl`

If the endpoint is slow/suspended, `curl https://$EP/status` (and `/health`, `/jit`) can block for a
long default timeout, stalling the loop cadence. With auto-resume, a `/status` call to a suspended VM
blocks for the whole resume. GitHub calls can hang too.

**Fix:** add `--max-time`/`--connect-timeout` to every `curl`.

### S10 (LOW-MEDIUM) — data race on `started` in the launcher

`handleStatus` reads `started` (plain `bool`) with no lock while `handleJit` writes it under `mu`.
Race detector will flag it; harmless in practice (bool won't tear) but sloppy.

**Fix:** make `started` an `atomic.Bool` (like `jobDone`) or read it under `mu`.

### S11 (LOW) — region consistency not enforced

CDK deploys to `CDK_DEFAULT_REGION ?? 'ap-northeast-1'`; scripts use `AWS_REGION` from `config.env`.
If they differ, the bucket/role are in one region and the S3 upload / `create-microvm-image` in
another (cross-region S3 URI → likely failure).

**Fix:** derive one from the other, or assert `CDK_DEFAULT_REGION == AWS_REGION` in `build-image.sh`.

### S12 (LOW) — `run-microvm` failure detail is swallowed by `set -e`

`RUN=$(LM run-microvm ...)` under `set -e` aborts on any run error before the trap is armed (no VM
created, so no orphan — good), but you lose the error body. Capture stderr and echo it so quota /
validation errors are visible on first run.

### S13 (LOW) — pinned `RUNNER_VERSION=2.335.1`

Phase 1 fetched the latest runner; Phase 2 pins. GitHub enforces a minimum runner version for JIT
registration; a stale pin can be rejected later. Fine for now (recent), but note it as a maintenance
trap. Also `RUN` for get-microvm never checks the runner downloaded arch matches the MicroVM arch —
though the in-Dockerfile `dpkg --print-architecture` detection makes it self-consistent with whatever
arch Lambda builds on, so this is low risk.

---

## Dockerfile / snapshot-compatibility assessment (question #5)

Lower risk than the README fears, for a non-obvious reason: **the snapshot is taken at build time,
after `/ready`, before any job runs.** The GitHub runner isn't even started at snapshot time (the
launcher only spawns `run.sh` on `/jit`, post-restore). So the frozen/restored process is just an
idle HTTP server — trivially snapshot-safe. The runner starts fresh after restore, so classic
snapshot hazards (frozen TCP long-poll, stale entropy in the running runner) don't apply to it.

Remaining real risks:
- **`ubuntu:22.04` as the container base:** allowed (Linux, public), but docs steer you to
  `public.ecr.aws/lambda/microvms:al2023-minimal` and require "snapshot compatible." Ubuntu should
  boot under the AL2023 MicroVM base, but pulling `ubuntu:22.04` from Docker Hub during the AWS build
  is subject to **Docker Hub anonymous rate limits** → intermittent build failures. Recommend
  switching `FROM` to `public.ecr.aws/lambda/microvms:al2023-minimal` (guaranteed reachable +
  snapshot-compatible); then replace `apt-get`/`dpkg` with `dnf` and the runner's
  `installdependencies.sh` (which is apt-based) with the AL2023 deps. This is a non-trivial rewrite —
  so for the *first* spike run, keeping Ubuntu is a reasonable gamble, just be ready for a Docker Hub
  or snapshot-compat failure and have the AL2023 variant on standby (the README already flags this).
- `set -eux` and the amd64→x64 / arm64→arm64 mapping are correct.
- `.NET` runner deps: installed via apt at build inside the Ubuntu stage, so they're present in the
  app rootfs; fine as long as the runner runs as the `runner` user (it does) and the AL2023 kernel
  runs Ubuntu glibc userland (normally fine).

---

## CDK assessment (question #6)

- **`sts:TagSession` trust statement:** correctly added as a second trust-policy statement for
  `lambda.amazonaws.com`. Harmless if unneeded, correct if needed. OK.
- **Bucket:** `BLOCK_ALL` + `enforceSSL` + `S3_MANAGED` + `autoDeleteObjects` + `DESTROY` — clean,
  and `bucket.grantRead(buildRole)` gives the build role S3 read. OK.
- **Build role permissions are sufficient for a PUBLIC base image** (S3 read + logs). If you switch
  to a **private ECR** base, you must add `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
  `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer` (docs). The public ECR AL2023 base
  recommended above does **not** require these.
- **No execution role needed** — confirmed optional (see "CORRECT" section).
- **Outputs** `ArtifactBucketName` / `BuildRoleArn` match the `jq` paths
  `.MayflySpikeStack.ArtifactBucketName` / `.BuildRoleArn`. OK.
- `package.json` `bin` → `bin/mayfly-spike.js` is unused (cdk.json runs the `.ts` via ts-node);
  harmless.

---

## Minimum fix list before first run

1. **S3** — fix `CREATION_FAILED` (+ `UPDATE_FAILED`), accept `CREATED|UPDATED`, verify version
   `SUCCESSFUL`/`ACTIVE`, exit non-zero on timeout. *(prevents a 20 min wasted cycle + bad-ARN run)*
2. **S4** — configure the `/ready` hook + hook port in `create-microvm-image`. *(prevents build
   hang / snapshot-before-listening)*
3. **S5** — `trap ... EXIT INT TERM`. *(prevents orphaned billing on Ctrl-C)*
4. **S1 + S2** — stop polling `/status` over the endpoint during the idle window; observe state via
   `get-microvm` only; and run at least one hostile config (short idle + long job) so the test can
   actually FAIL. *(otherwise the spike does not answer Unknown #2 and RESULT.md would overclaim)*
5. **S6** — make re-runs rebuild via `update-microvm-image`. *(prevents testing a stale snapshot)*
6. **S7/S8/S9** — correlate the GitHub run correctly, assert an explicit PASS/FAIL with exit code,
   add `curl --max-time`.

Once S1–S6 are addressed the harness will both cost-safely tear down and produce a result that
genuinely bears on Unknown #2. S10–S13 are polish.
