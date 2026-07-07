# Mayfly — Design Spec

- **Status:** Draft for review
- **Date:** 2026-07-07
- **Supersedes:** the abandoned "Meridian" regional-egress direction (archived under `docs/attic/`)

## Summary

Mayfly runs GitHub Actions jobs on **AWS Lambda MicroVMs** as **ephemeral, VM-isolated,
VPC-native self-hosted runners.** Each job gets a fresh MicroVM that resumes from a warm
snapshot, registers just-in-time for a single job, can privately reach your AWS resources
(RDS, internal services) through a VPC egress connector under a per-workflow access
policy, and is destroyed on completion. No standing runner fleet; scale-to-zero.

*(A mayfly is born, does one thing, and dies within a day — the runner lifecycle.)*

## Why (value proposition)

Existing options each miss something:

- **GitHub-hosted runners:** no native AWS VPC access — can't reach your private resources.
- **Self-hosted runners (EC2 / ARC-on-k8s):** get VPC access, but require a **standing
  fleet + ops**, and container runners share a kernel (weaker isolation).

**Mayfly's combination is the gap:** serverless + ephemeral + per-job VM isolation +
native VPC access + policy-governed — with no fleet to run.

**Headline demo:** an ephemeral, isolated CI job **securely queries a VPC-private RDS** —
something GitHub-hosted runners cannot do.

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

A developer/team running CI on AWS who needs jobs to reach **private** AWS resources
without a standing self-hosted fleet or public exposure.

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
5. **Network profile** — v1: internal jobs get a single security group to the demo's private
   resources; **fork-PR jobs get none** (the fork check is the gate). See Access policy.
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

## Access policy (v1: minimal; governance as a documented extension)

- **v1 (built):** internal jobs get a **single security group** to the demo's private resources
  (the VPC-only RDS); **fork-PR jobs get no VPC access** (decided by the mandatory fork check).
  One boolean — no policy engine, but the load-bearing safety property is present.
- **Production hardening (documented, not built in v1):** a small policy — in-repo file or
  SSM — mapping trigger context (branch, event, fork vs internal) → network profile (which
  SG, or none), so fork-PR code gets no private access. This is the "invisible fences"
  story; the write-up describes it, v1 doesn't implement the engine.

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

- Open a PR → a job runs on a Mayfly MicroVM runner (visible in the GitHub UI + logs).
- The job **privately queries a VPC-only RDS** and succeeds — demonstrably impossible on
  GitHub-hosted runners.
- Metrics show warm-resume start latency and per-job fresh-VM isolation.
- `cdk deploy` reproduces it; a README explains setup and honest limits.

## Open questions

**Resolved:** repo → rename `meridian` → `mayfly`; Docker-in-job → out of v1; access policy
→ v1 uses a single security group (governance engine deferred).

**Still open (sensible defaults chosen during planning):** warm-pool size and max-runtime
cap values.
