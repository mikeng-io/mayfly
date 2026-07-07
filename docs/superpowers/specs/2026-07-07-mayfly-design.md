# Mayfly — Design Spec

- **Status:** Draft v2 — revised per the pre-build review
  ([`docs/reviews/2026-07-07-mayfly-design-review.md`](../../reviews/2026-07-07-mayfly-design-review.md))
- **Date:** 2026-07-07
- **Supersedes:** the abandoned "Meridian" regional-egress direction (archived under `docs/attic/`)

## Summary

Mayfly runs GitHub Actions jobs on **AWS Lambda MicroVMs** as ephemeral, single-use runners.
Its distinctive, **measurable** property: a MicroVM can **suspend to ~zero cost and resume in
milliseconds**, so Mayfly gives fast job starts *without* paying for an idle fleet — the trade
CodeBuild forces you to choose (reserved capacity = pay for idle, on-demand = cold start).
Because each job runs in a **microVM (its own kernel)**, Mayfly *additionally* gives a stronger
isolation boundary than container-based runners — useful as **defense-in-depth** when CI runs
code you don't fully trust (e.g. hostile fork PRs). No standing fleet; scale-to-zero.

*(A mayfly is born, does one thing, and dies within a day — the runner lifecycle.)*

## Why (value proposition)

Every managed runner forces a trade or shares a kernel:

- **GitHub-hosted / CodeBuild / ARC** — all **container-based** (shared kernel). And CodeBuild
  makes you pick **reserved** (fast, pay-for-idle) *or* **on-demand** (cheap, cold start).
- **Self-hosted EC2 / k8s** — a **standing fleet + ops**.

**Mayfly's measurable edge:** MicroVM **suspend/resume delivers warm-start latency at ~zero idle
cost** — a combination none of the above offers. (Verified: a suspended MicroVM incurs no compute
charge and resumes from a memory+disk snapshot.)

**Secondary, architectural:** a microVM has its **own kernel** (a VM boundary) — a stronger
isolation model than a shared-kernel container, i.e. genuine **defense-in-depth** for the narrow
but real case of running code you don't trust (hostile fork PRs; arbitrary submitted code).
*Honest caveats:* this is defense-in-depth, **not** a stageable "escape blocked on Mayfly,
succeeds on CodeBuild" demo; and **"AI-generated" ≠ "adversarial"** — your own agent's code is
unpredictable, not hostile, and a container contains it fine.

## Goals

- A deployable (CDK) system that runs real GitHub Actions jobs on MicroVM runners.
- **Prove the warm-start-at-zero-idle-cost property with real numbers** — the core claim.
- Per-job microVM isolation; trust-gated access to private resources.
- Operationally sound: reconciliation, safety caps, observability.

## Non-goals (v1)

- Load-based autoscaling (fixed warm pool + reconciler refill only).
- Org / multi-repo; label routing beyond one label.
- **Running Docker inside a job** (a Dockerfile still builds the runner image; jobs don't run Docker).
- **Fine-grained domain-level egress control** — needs an egress proxy (the abandoned Meridian
  problem); explicitly out (see Access governance).
- Cost dashboards, UI, multi-region.

## Users

Teams running GitHub Actions on AWS who want **fast, isolated, pay-per-use runners with no
standing fleet**. Secondary: maintainers/teams whose CI runs code they don't fully trust (hostile
fork PRs) and want a **VM boundary** rather than a shared kernel.

## The crux — verify FIRST (kill-criterion spike)

Before any real build, prove end-to-end in a live AWS account:

> control plane → the MicroVM's **L7 endpoint** → an **in-VM launcher** receives the JIT config →
> **one real GitHub Actions job runs to clean exit inside a single held MicroVM**.

Two unknowns this resolves — the whole project rests on them:

1. Can we hand the JIT config to an in-VM agent **over the L7 endpoint** (there is no SSH / raw
   socket / inbound IP) and start `run.sh`?
2. **Does the MicroVM stay running (not auto-suspend) while the runner long-polls and executes**
   the job for its full duration (minutes)?

If either fails → **stop or reshape.** Approach B does **not** dodge this — it's the same
mechanism minus the pool.

## Architecture

All TypeScript; AWS CDK for IaC. GitHub mechanics grounded in
[`docs/research/github-actions-jit-runners.md`](../../research/github-actions-jit-runners.md).

1. **Webhook receiver** (Lambda + Function URL) — verify `X-Hub-Signature-256`, filter
   `action == queued` with `labels ⊇ {self-hosted, mayfly}`, **return 2xx immediately**, enqueue.
   Route `completed` to teardown.
2. **Provision queue** (SQS, short delivery delay) — decouples the ack from async provisioning.
3. **Control plane** (Lambda, off SQS) — **re-check still `queued`** → **fork check** (trust
   classification) → resume (or launch) a MicroVM → **call the MicroVM's L7 endpoint
   (bearer-authed) to hand its in-VM launcher the JIT config** → record correlation. Teardown +
   refill on `completed`/exit.
4. **Runner MicroVM image** — Dockerfile-built: the GitHub Actions runner + toolchain **plus a
   small in-VM launcher agent** that listens on the MicroVM's HTTP endpoint, receives the JIT
   config, and runs `run.sh --jitconfig <blob>` for exactly one job. *This launcher is the
   concrete answer to "how do you inject on resume" given L7-only ingress.*
5. **Access governance (honest scope)** — trust classification (fork/untrusted vs internal):
   **untrusted ⇒ no private-VPC access; trusted ⇒ security group to the demo's private resource.**
   SGs are **IP/port only**, so this is a *private-resource-reachability boolean*, **not** a domain
   allowlist. (Domain-level "invisible fences" would need an egress proxy — out of scope.)
6. **State** (DynamoDB) — pool inventory + correlation `{jobId → microvmId → runnerName}` +
   lifecycle state; idempotency keyed on `jobId`.
7. **Reconciler** (EventBridge Scheduler Lambda) — two-phase orphan sweep (mark-then-terminate),
   refill the pool, enforce a max-runtime cap. **Not optional** — webhook delivery isn't guaranteed.
8. **Auth** — a **GitHub App** (Administration:write, Actions:read); 1-hour install tokens minted
   from the webhook's `installation.id`.
9. **Provider interface** — CI-specific surface behind an interface; GitHub adapter only in v1.

## Job lifecycle — build B first, then C

**Approach B (de-risking baseline — build first).** `queued` → 2xx → SQS(delay) → re-check →
fork check → **launch a fresh MicroVM** → control plane hands its in-VM launcher the JIT config →
runner runs one job → self-terminate + reconcile. Simplest; proves the crux.

**Approach C (the differentiator — add only after B works).** Keep a warm pool of **suspended**
MicroVMs; on a job, **resume** instead of launch (ms) → same JIT hand-off. This is what delivers
**warm-start-at-zero-idle-cost — the thesis.** It's the payoff, not a fallback.

**Teardown (three layers):** (a) the MicroVM self-terminates when the runner process exits
(authoritative); (b) the `completed` webhook is a fast-path trigger; (c) the reconciler sweeps
leaks. On teardown, launch + suspend a replacement to hold the pool.

## SRE / operational design

- **Failure modes handled:** missed `completed` webhook, MicroVM crash, stuck job, control-plane
  failure mid-provision. The reconciler (desired-vs-observed diff over DynamoDB) is the backbone.
- **Safety rails:** max-runtime cap per MicroVM; max pool/concurrency cap → bounded blast radius + cost.
- **Observability:** structured logs + CloudWatch metrics (**warm-resume vs cold latency** — the
  headline metric — plus jobs run, leaked-VM reclaims, GitHub API quota remaining).

## Tech choices

- **TypeScript end-to-end** (CDK + Lambdas + the in-VM launcher can be Go or Node — decide at spike).
- AWS: Lambda MicroVMs, Lambda, SQS, DynamoDB, EventBridge Scheduler, SSM, S3 (MicroVM image), CDK.
- Quality: ESLint + Prettier, strict `tsconfig`, cdk-nag; unit tests for the control-plane state
  machine + reconciler; CDK assertion tests.

## Risks → resolve as spikes

1. **The crux (above)** — kill-criterion; do it first.
2. **MicroVM CDK maturity** (~2 weeks post-GA) — likely L1 `Cfn*` or a **Lambda-backed custom
   resource** around run/suspend/resume/terminate. Plan for custom-resource glue; tempers "just
   `cdk deploy`."
3. **Per-job SG vs pool-per-profile** — verify whether the VPC/egress SG can vary per MicroVM
   invocation; if not, trust profiles force separate warm pools.
4. 8h cap / 5 regions / launch rate — non-issues at showcase scale.

## Success criteria (honest, demonstrable)

- A real GitHub Actions job runs on a Mayfly MicroVM runner (visible in the GitHub UI + logs).
- **Measured (the core claim):** warm-resume start latency + cost vs a cold launch — with numbers,
  showing it beats CodeBuild's reserved-vs-on-demand trade.
- **Shown, not staged:** each job is a separate microVM (own kernel); an untrusted (fork) job is
  **denied private-VPC access** while a trusted job reaches the demo resource.
- `cdk deploy` reproduces it (incl. any custom-resource glue); a README states honest limits and
  when CodeBuild is the better choice.

## Open questions

**Resolved:** repo → `mayfly`; Docker-in-job → out; **thesis → lead with suspend/resume cost,
isolation as honest defense-in-depth (not "AI = adversarial")**; **governance → private-resource
boolean, no domain allowlist**.

**Still open (decide at/after the spike):** warm-pool size + max-runtime defaults; per-job-SG
feasibility; language for the in-VM launcher.
