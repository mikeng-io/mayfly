# Mayfly — Design Spec

- **Status:** Draft for review
- **Date:** 2026-07-07
- **Supersedes:** the abandoned "Meridian" regional-egress direction (archived under `docs/attic/`)

## Summary

Mayfly runs **untrusted and AI-generated code in CI** on **AWS Lambda MicroVMs**. Each
GitHub Actions job runs in a fresh, single-use MicroVM — **its own kernel, a true VM
isolation boundary** — so code you can't trust (fork PRs, AI-agent-authored changes,
AI-generated artifacts) is contained in a way a *container* runner cannot match. Its access
to your resources is **governed by policy** ("invisible fences"): it reaches only what it's
allowed to, and nothing else. The runner registers just-in-time for one job and is destroyed
on completion. No standing fleet; scale-to-zero.

*(A mayfly is born, does one thing, and dies within a day — the runner lifecycle.)*

## Why (value proposition)

The problem: **AI agents now write code, and CI increasingly runs code you didn't write** —
fork PRs, AI-authored changes, AI-generated artifacts. Running that in CI means running
**untrusted** code, often with access to secrets and private resources.

Every managed CI runner is **container-based** — GitHub-hosted, CodeBuild-hosted runners,
ARC-on-k8s — so untrusted code runs on a **shared kernel**. Mayfly runs it in a **microVM**
(own kernel, VM boundary) and **governs its access** with policy. That combination —
VM-isolated *and* access-governed untrusted-code execution, integrated into your existing
GitHub Actions workflow — is the gap.

*(Secondary, real but narrower: MicroVM suspend/resume gives fast start at ~zero idle cost —
a trade CodeBuild forces you to make. See `docs/mayfly-vs-codebuild.html`.)*

**Headline demo:** untrusted / AI-generated code runs in a CI job, is **contained in its
microVM** (can't escape to the host or other jobs) and **can reach only what policy allows**
(the test DB, nothing else) — visibly stronger than a container runner.

## Goals

- A deployable (CDK) system that runs real GitHub Actions jobs on MicroVM runners.
- Native, **policy-gated** VPC access to private resources.
- Per-job VM isolation; scale-to-zero (no idle fleet).
- Operationally sound: reconciliation, safety caps, observability (the SRE core).

## Non-goals (v1)

- Load-based autoscaling (fixed warm pool + reconciler refill only).
- Org / multi-repo management; label routing beyond one runner label.
- CI providers other than GitHub Actions (architecture leaves room; only GitHub built).
- **Running Docker inside a job** (`docker build`/`run` as a CI step) — explicitly out of
  v1. *(We still author a Dockerfile to* build *the runner MicroVM image — that's how
  MicroVM images are made — but jobs themselves don't run Docker.)*
- Cost dashboards, UI, multi-region.

## Users

A team whose CI runs code it can't fully trust — **open-source maintainers** taking fork
PRs, and teams running **AI-agent-authored or AI-generated code** in their pipelines — who
want VM-grade isolation and governed access without abandoning GitHub Actions.

## Architecture

All TypeScript; AWS CDK for IaC. GitHub mechanics grounded in
[`docs/research/github-actions-jit-runners.md`](../../research/github-actions-jit-runners.md).

1. **Webhook receiver** (Lambda + Function URL) — verifies the `X-Hub-Signature-256` HMAC,
   filters `action == queued` with `labels ⊇ {self-hosted, mayfly}`, **returns 2xx
   immediately**, and enqueues the job. Routes `completed` to teardown.
2. **Provision queue** (SQS, short delivery delay) — decouples the fast ack from async
   provisioning and lets fast cancellations settle before we launch.
3. **Control plane** (Lambda, off SQS) — **re-checks the job is still `queued`**, runs the
   **fork check** (`GET .../actions/runs/{run_id}` → compare `head_repository.id`), resumes a
   suspended MicroVM, mints a **JIT config** (`generate-jitconfig`, `name` = job id) and injects
   it, records correlation. On `completed`/exit: terminate + refill.
4. **Runner MicroVM image** — Dockerfile-built image with the Actions runner agent + toolchain;
   boots ready and is suspended *un-registered*; on resume it runs `./run.sh --jitconfig <blob>`
   for exactly one job, then the process exits (self-clean).
5. **Access governance** — classify each job (fork / AI-marked = untrusted) → apply a
   **deny-by-default** network profile for untrusted jobs, a broader one for trusted. A
   first-class pillar (see Access governance).
6. **State** (DynamoDB) — pool inventory + correlation record `{jobId → microvmId → runnerName}`
   + lifecycle state; the desired-vs-observed source of truth. Idempotency keyed on `jobId`.
7. **Reconciler** (EventBridge Scheduler Lambda) — two-phase orphan sweep (mark-then-terminate),
   refill the pool, enforce a max-runtime cap. **Not optional** — webhook delivery isn't guaranteed.
8. **Auth** — a **GitHub App** (Administration:write, Actions:read [+ org Self-hosted
   runners:write]); 1-hour installation tokens minted from the webhook's `installation.id`.
9. **Provider interface** — the CI-specific surface behind an interface; GitHub adapter only in v1.

## Job lifecycle (Approach C — snapshot-warm + JIT-on-resume)

1. **Warm pool:** N MicroVMs booted with runner + toolchain, then **suspended** (near-zero
   cost), NOT yet registered.
2. `workflow_job: queued` webhook → verify + label-filter → **return 2xx** → enqueue (SQS, short delay).
3. Control plane (off SQS): **re-check still queued** → **fork check** → pick a suspended VM and
   **resume** it (ms) → attach the network profile (fork ⇒ none, internal ⇒ demo SG) → mint a
   **JIT config** (`name` = job id) and inject → runner runs `./run.sh --jitconfig …` for one job.
4. **Teardown, three layers:** (a) the MicroVM self-terminates when the runner process exits
   (authoritative); (b) the `completed` webhook is a fast-path trigger; (c) the reconciler sweeps
   anything that leaked. On teardown, **launch + suspend a replacement** to hold the pool.

**Fallback (Approach B)** if JIT-on-resume proves awkward: pure launch-per-job from the snapshot,
no suspended pool. Still a valid showcase (snapshot launches are quick).

## Access governance ("invisible fences") — a first-class pillar

Because the whole point is running **untrusted** code, controlling what it can reach is core,
not an add-on.

- **Trust classification:** each job is classified — *trusted* (internal branch) or
  *untrusted* (fork PR, or a workflow/label marking AI-generated code). The fork check
  (`GET .../actions/runs/{run_id}`, compare `head_repository.id`) drives this.
- **Network profile per trust level:** untrusted jobs get a **deny-by-default** profile —
  a security group / egress allowlist scoped to only what they legitimately need (e.g. the
  test DB, package registries); trusted jobs get a broader profile. No profile = no private access.
- **v1 scope:** a small policy config (in-repo file or SSM) mapping `{trust level} → {network
  profile}`, applied when the MicroVM is provisioned. Two or three profiles is enough to
  *demonstrate* governed isolation — this is the demo, not a deferred extension.

## SRE / operational design

- **Failure modes handled:** missed `completed` webhook, MicroVM crash, stuck job,
  control-plane failure mid-provision. The reconciler (desired-vs-observed diff over
  DynamoDB) is the correctness backbone.
- **Safety rails:** max-runtime cap per MicroVM; max pool/concurrency cap → bounded blast
  radius and cost.
- **Observability:** structured logs + CloudWatch metrics (provision latency, warm-resume
  vs cold, jobs run, leaked-VM reclaims).

## Tech choices

- **TypeScript end-to-end** (CDK + Lambdas) — single toolchain, adoptable. *(Recommendation;
  overridable to Python.)*
- AWS: Lambda MicroVMs, Lambda (control plane), DynamoDB, EventBridge Scheduler, SSM, S3
  (MicroVM image), CDK.
- Quality: ESLint + Prettier, strict `tsconfig`, cdk-nag; unit tests for the control-plane
  state machine + reconciler; CDK assertion tests.

## Risks → resolve as the plan's first spikes (before building the pool)

1. **JIT-config injection on resume** (crux of Approach C) — fallback B.
2. *(Deferred — not a v1 gate)* Running Docker inside a job — future work.
3. **MicroVM CDK construct level** (L1 vs Lambda-backed custom resource).
4. **GitHub `workflow_job` webhook + JIT ephemeral registration** end to end.

## Success criteria (the showcase)

- A CI job runs code marked **untrusted / AI-generated** on a Mayfly MicroVM runner.
- **Isolation shown:** the job is contained in its own microVM — a container-escape-style
  probe that would cross a shared kernel gets nothing; each job is a fresh VM.
- **Governance shown ("invisible fences"):** the untrusted job reaches only its
  policy-allowed resource (the test DB) and is **blocked from everything else**; a trusted
  job gets the broader profile.
- *(Secondary)* metrics show warm-resume latency vs cold.
- `cdk deploy` reproduces it; a README explains setup and honest limits (incl. why this is
  for untrusted-code CI, and when CodeBuild is the better choice).

## Open questions

**Resolved:** repo → rename `meridian` → `mayfly`; Docker-in-job → out of v1; access policy
→ v1 uses a single security group (governance engine deferred).

**Still open (sensible defaults chosen during planning):** warm-pool size and max-runtime
cap values.
