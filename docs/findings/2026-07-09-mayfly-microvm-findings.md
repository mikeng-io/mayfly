# Findings — Ephemeral GitHub Actions runners on AWS Lambda MicroVMs (Mayfly)

- **Date:** 2026-07-09
- **Status:** Feasibility fully validated on real AWS (Tokyo, `ap-northeast-1`). Control plane not yet built.
- **Scope of this doc:** what was tested, the evidence, and the honest constraints. Raw material — not the article.

---

## Summary

We set out to answer one question: **can AWS Lambda MicroVMs (GA 2026-06-22) serve as ephemeral,
per-job GitHub Actions runners?** Answer: **yes**, verified end-to-end on real MicroVMs — including
the two things that could have killed it (does the MicroVM stay alive through a job; can it build
containers). The runner model is a clean drop-in for ARM-native CI; the honest limits are
architecture (ARM64 only) and a few AWS-side sharp edges.

**Mayfly** = each CI job runs in a fresh, single-use MicroVM: JIT-registered for one job, dies on
completion. No standing fleet.

---

## What was verified (the ladder)

| # | Claim | Where | Result |
|---|-------|-------|--------|
| 1 | JIT config → in-VM launcher over HTTP → one real GHA job to clean exit | local (Docker stand-in) | ✅ |
| 2 | A **real Lambda MicroVM stays RUNNING** while the runner long-polls + executes a job | real MicroVM | ✅ (Unknown #2) |
| 3 | **`docker build` / `docker run` inside the MicroVM** | real MicroVM | ✅ (first try) |
| 4 | Real **npm build** (Astro → Vite/esbuild/Rollup native deps) with no arch friction | real MicroVM | ✅ |
| 5 | GHA **`services:` container** (Postgres) integration test — full lifecycle | real MicroVM | ✅ |

---

## Findings in detail (with evidence)

### 1. The JIT hand-off works over the MicroVM's L7 endpoint
A MicroVM exposes only an **L7 HTTPS endpoint** (HTTP/2/gRPC/WebSocket, `X-aws-proxy-auth` bearer,
default port 8080) — **no raw L4 socket, no stable public IP.** So the control plane can't "push"
a config in the usual way. The pattern that works: a small **in-VM launcher** (HTTP server) that
receives the JIT config at `POST /jit` and execs `./run.sh --jitconfig <blob>`.

> Evidence (real MicroVM): `endpoint health http:200` → `jit http:202` → runner connected to GitHub.

The GitHub runner needs **no inbound** — it dials GitHub outbound and long-polls. JIT config
(`generate-jitconfig`) is single-use; the runner auto-deregisters after one job.

### 2. A MicroVM holds a runner through a job — Unknown #2 (the make-or-break)
**The risk:** MicroVM auto-suspend is triggered by **inbound endpoint traffic**, but the runner
talks **outbound only** (long-poll to GitHub). So a naive idle policy would suspend the MicroVM
mid-job. (AWS docs confirm and advise disabling auto-suspend for async apps.)

**Result:** with auto-suspend off (no idle policy), the MicroVM stayed `RUNNING` for the whole job:

> `microvm=RUNNING` at t=10s … 140s while a real 120 s job ran; `ghrun=completed/success`.

**Design consequence:** the control plane must run job-carrying MicroVMs with auto-suspend **off**,
and suspend/resume them **explicitly** between jobs (for the warm-pool economics). Observation must
be via the control-plane `get-microvm` API — **not** the endpoint, because hitting the endpoint is
itself the inbound traffic that resets the idle timer (a genuine measurement trap we hit).

### 3. Docker-in-MicroVM works
A MicroVM is a full VM (own kernel), so it can run `dockerd` inside it — nested *containers-in-a-VM*
(like Docker on EC2), **not** nested virtualization. Setup: install `dockerd` in the image, grant
`--additional-os-capabilities '["ALL"]'` at image-create, run as root, start `dockerd` lazily on
first job (so we don't snapshot a running daemon).

> Evidence (job log): `docker version` → `OS/Arch: linux/arm64`; `Hello from Docker!`;
> `Successfully tagged mayfly-test:latest`; ran the built image → `completed/success`. **First try.**

So Mayfly can build container images — natively for ARM64.

### 4. Real ARM64 npm build — no friction
A minimal Astro app (which pulls the arch-sensitive native deps: Vite, esbuild, Rollup):

> `setup-node` → `npm install` (**329 packages, no arch errors**) → `astro build` → `dist/` →
> `ASTRO_BUILD_OK arch=aarch64` → `completed/success`.

The lockfile is **not** x86-locked — it records optional native deps for all platforms and npm
installs the arm64 variants. The only known failure mode (stale/incomplete lockfile →
`Cannot find module @rollup/rollup-linux-arm64-gnu`) is an **npm/ecosystem** issue that hits any
ARM64 CI, fixed by regenerating the lockfile — not a Mayfly defect.

### 5. GHA `services:` containers work (integration tests)
The runner ran the full `services:` lifecycle inside the MicroVM: it started a `postgres:16`
**service container** (arm64) via the MicroVM's Docker, waited for its health check, a step connected
and queried it, and GHA tore it down — no special config, just standard `services:` YAML.

> Evidence: `pg_isready` ok → `psql … select version()` → `PostgreSQL 16.14 … aarch64` →
> service container stopped/removed → `completed/success`.

So the common **integration-test-against-a-real-DB** pattern works on Mayfly out of the box.

---

## Constraints discovered (honest)

- **ARM64 (Graviton) only.** The MicroVM base is Amazon Linux 2023 **aarch64**. Native builds are
  ARM. x86 needs `docker/setup-qemu-action` + `setup-buildx-action` (QEMU **emulation** — slower,
  and binfmt-in-MicroVM is **not yet verified**). No evidence of an x86 MicroVM base.
- **L7-only ingress.** No raw L4 / stable public IP inbound. (This is what killed an earlier
  "serverless regional proxy" idea — a transparent SNI proxy needs L4; irrelevant for a runner,
  which only needs outbound to GitHub.)
- **Auto-suspend is inbound-traffic-driven**; min `maxIdleDurationSeconds` is **60 s**.
- **Runner image "fatness" is a design axis.** Lean image + `setup-*` actions covers modern
  workflows (verified); "assume-it's-installed" workflows need a fatter, GitHub-runner-like image.
- **8 h max runtime, 5 GA regions, RunMicrovm ~5 TPS, per-region memory pool** — relevant at scale,
  not for a runner PoC.

---

## Honest positioning (why not the obvious alternatives)

- **AWS CodeBuild already hosts GHA runners in your VPC** (GA 2024-04, managed, mature). For
  *production* CI, use it. Mayfly's genuine edges: **microVM (own-kernel) isolation** for untrusted
  code, and **warm-start at ~zero idle cost** via suspend/resume — CodeBuild forces you to choose
  *reserved* (fast, pay-for-idle) **or** *on-demand* (cheap, cold). Narrow but real.
- **Self-hosted EC2 / ARC-on-k8s runners** get VPC access but need a standing fleet + ops, and
  container runners share a kernel.

The article should address "why not CodeBuild" head-on — the honest answer is what makes it credible.

---

## Field notes — AWS Lambda MicroVM gotchas (the messy bits)

Real friction hit while building the spike (the useful, article-worthy part):

- **CLI must be current.** `aws-cli/2.1.2` (2020) didn't know `lambda-microvms` at all → upgrade to
  ~2.28+.
- **`--hooks` shorthand → a bogus `403 AccessDenied: "Unable to determine service/operation name"`.**
  The minimal call (no `--hooks`) works; use the JSON form or omit. Build hooks are optional —
  runtime endpoint traffic flows without a `/run` hook.
- **Image failure state is `CREATION_FAILED`/`UPDATE_FAILED`** (not `CREATE_FAILED`). Three
  independent states: image (`CREATED`/`UPDATED`), version (`SUCCESSFUL`/`FAILED`), activation
  (`ACTIVE`). A `CREATED` image can hold a `FAILED` version.
- **`get-microvm-image` / `run-microvm --image-identifier` need the full ARN**, not the name
  (resolve name→ARN via `list-microvm-images`). But MicroVM ops (`get/terminate-microvm`,
  `create-microvm-auth-token`) take the **microvm ID**.
- **Region:** the account default region ≠ a MicroVM region. `ap-southeast-1` (Singapore) has **no**
  MicroVMs; pin explicitly to a GA region (we used Tokyo). A default-region clobber silently sent a
  `list` to the wrong region.
- **Docker inside** needs `--additional-os-capabilities '["ALL"]'` + root + `RUNNER_ALLOW_RUNASROOT=1`.
- **Cost model:** running = compute; **suspended = snapshot storage only** (no compute); terminated
  = nothing. `--maximum-duration-in-seconds` (≤ 28,800 / 8 h) is a hard backstop.
- **Teardown discipline matters** — a `set -u` crash once skipped an auto-terminate and left a
  MicroVM running; trap `EXIT INT TERM`, and keep a resource ledger (we did — `AWS-LEDGER.md`).
- **IAM actions are under the `lambda:` prefix, NOT `lambda-microvms:`** (the latter is only the
  CLI/SDK client name). The control plane needs `lambda:RunMicrovm`, `TerminateMicrovm`, `GetMicrovm`,
  `ListMicrovms`, `ListMicrovmImages`, `GetMicrovmImage`, `CreateMicrovmAuthToken` — **and**
  `lambda:PassNetworkConnector` (RunMicrovm authorizes this against the ingress/egress connector ARNs
  `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:{ALL_INGRESS,INTERNET_EGRESS}`).
  A `lambda-microvms:*` policy is silently useless — you only find out at RunMicrovm time. (Verified
  live: the deployed control plane 403'd on `lambda:ListMicrovmImages`, then `lambda:PassNetworkConnector`.)
- **`get-microvm-image --image-identifier <name>` fails** (needs the ARN `arn:aws:lambda:<region>:<acct>:microvm-image:<name>`);
  poll build state via `list-microvm-images` filtered by name instead.
- **In-VM `uname -n` is `localhost`** — use `RUNNER_NAME` (the JIT runner name) to identify a run, not the hostname.

---

## Not done / not verified

- **The real control plane** — webhook (Lambda Function URL) → SQS → control Lambda → reconciler →
  DynamoDB. *Designed* (`docs/superpowers/specs/2026-07-07-mayfly-design.md`), **not built.**
- x86 / binfmt / QEMU multi-arch inside a MicroVM.
- `actions/cache` at scale, matrix jobs.
- The warm-pool + reconciler + governed VPC-private-access at load; multi-tenant.
- The HAZARD experiment (empirically showing auto-suspend *would* kill a mid-job runner) — the SAFE
  (design) config was proven; the hazard characterization was left (`HAZARD_IDLE=60`, deliberately
  short idle + long job) as a documented follow-up.

---

## Cost

No standing compute. The whole validation cost a few **cents** (a handful of short MicroVM runs, all
auto-terminated). Standing footprint ≈ $0: CDKToolkit + spike stack (empty bucket + role) + two tiny
MicroVM images. Every resource is CDK-managed or ledgered with a teardown step.

## Reproduce

- `spike/phase1-local/` — Unknown #1 (local, no AWS).
- `spike/phase2-aws/` — infra (CDK), image build, the two-experiment run, generic `run-job.sh`,
  Astro workflow, and `AWS-LEDGER.md`.
- `spike/phase2b-docker/` — Docker-in-MicroVM.
