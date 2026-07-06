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
- Container image builds inside the MicroVM **unless the spike proves it cheap** (stretch).
- Cost dashboards, UI, multi-region.

## Users

A developer/team running CI on AWS who needs jobs to reach **private** AWS resources
without a standing self-hosted fleet or public exposure.

## Architecture

All TypeScript; AWS CDK for IaC.

1. **Webhook receiver** (Lambda + Function URL) — verifies GitHub `workflow_job` webhooks;
   enqueues provision (`queued`) / teardown (`completed`).
2. **Control plane** (Lambda) — pool + job orchestration: resume a suspended MicroVM,
   mint & inject a JIT ephemeral runner config, mark busy; on completion terminate + refill.
3. **Runner MicroVM image** — Dockerfile-built image with the GitHub Actions runner agent
   + toolchain; boots to ready and is suspended *un-registered*; a lifecycle hook performs
   JIT registration on resume and runs one ephemeral job.
4. **Access policy** — maps workflow / branch / trust-level → allowed VPC egress connector
   + security group (which private resources this job may reach). Fork PRs default to none.
5. **State** (DynamoDB) — pool inventory, job↔MicroVM mapping, lifecycle state; the
   desired-vs-observed source of truth.
6. **Reconciler** (EventBridge Scheduler Lambda) — sweep orphaned/leaked MicroVMs, refill
   the pool to target, enforce a max-runtime cap.
7. **Provider interface** — the CI-specific surface (webhook parse, runner registration,
   job lifecycle) behind an interface; the GitHub adapter is the only v1 implementation.

## Job lifecycle (Approach C — snapshot-warm + JIT-on-resume)

1. **Warm pool:** N MicroVMs booted with runner + toolchain, then **suspended** (near-zero
   cost), NOT yet registered.
2. `workflow_job: queued` → control plane picks a suspended VM, **resumes** it (ms),
   resolves the job's access policy, attaches the matching VPC egress connector + SG,
   mints a **JIT ephemeral runner config** from GitHub, injects it → runner takes that one job.
3. Job runs in the isolated VM, with policy-scoped private access.
4. `workflow_job: completed` (or ephemeral runner exits) → control plane **terminates** the
   VM, records it, **launches + suspends a replacement** to hold the pool at target.
5. Reconciler sweeps anything that leaked.

**Fallback (Approach B)** if JIT-on-resume proves awkward: pure launch-per-job from the
snapshot, no suspended pool. Still a valid showcase (snapshot launches are quick).

## Access policy (governance pillar)

- Policy config (in-repo file or SSM) maps trigger context (branch, event, fork vs
  internal) → **network profile** (which VPC connector / SG, or none).
- **Default deny:** fork-PR jobs get no VPC access. Trusted branches get a least-privilege
  SG to declared resources (e.g., a dedicated test DB).
- This is "invisible fences" for CI network access — the safety story for running untrusted
  code with private reach.

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
2. **Container image builds inside a MicroVM** (dockerd or rootless kaniko/buildah) — gates
   "usable for image-building CI"; else the demo stays non-container.
3. **MicroVM CDK construct level** (L1 vs Lambda-backed custom resource).
4. **GitHub `workflow_job` webhook + JIT ephemeral registration** end to end.

## Success criteria (the showcase)

- Open a PR → a job runs on a Mayfly MicroVM runner (visible in the GitHub UI + logs).
- The job **privately queries a VPC-only RDS** and succeeds — demonstrably impossible on
  GitHub-hosted runners.
- Metrics show warm-resume start latency and per-job fresh-VM isolation.
- `cdk deploy` reproduces it; a README explains setup and honest limits.

## Open questions

- Repo strategy: repurpose this repo (rename `meridian` → `mayfly`) vs. a fresh repo.
- Default warm-pool size and max-runtime cap values.
- Where access policy lives (in-repo file vs SSM).
