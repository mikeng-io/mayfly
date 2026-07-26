# ADR-0004: Orphaned-job reconciliation against GitHub's queue

- **Status:** Proposed
- **Date:** 2026-07-27
- **Deciders:** Mike
- **Bounded contexts touched:** Reconciler, Control, GitHub integration

## Context

The control plane's provisioning model was strictly per-job: one
`workflow_job.queued` webhook → one SQS provision message → one MicroVM, with a
self-cancel guard ("run no longer queued" → skip the launch) to avoid paying for
VMs a completed run doesn't need.

GitHub does not honor that 1:1 intent. JIT runners register into a **label
pool**, and GitHub's scheduler hands a freshly-registered runner *any* queued
job with matching labels — not the job whose webhook minted it.

Incident 2026-07-26 (observed live, evidence in the Cortex bundle
`mayfly-exec-2026-07-26-r3`): two jobs queued 35s apart. The second job was
assigned the first job's runner and completed in 8s — before the second job's
own provision message cleared the queue's deliberate 20s delivery delay. That
provision then self-cancelled (its run was `completed`), which was locally
correct and globally wrong: the pool was now one VM short. The **first** job sat
queued for 2h38m — its webhook was already consumed, and nothing in the system
ever consulted GitHub's queue again. Each subsequent dispatch moved the bubble
to the newest job rather than draining it; it drained only when burst traffic
(with two cancelled runs) minted surplus VMs by luck.

A second observation from the same incident: the orphaned job's DynamoDB record
said `running` the whole time, because *its* VM was busy serving the other job.
Our own records can lie under cross-assignment; GitHub's `status == queued` is
the only trustworthy "unserved" signal.

## Options considered

### Option A — Bind runners to jobs

No GitHub mechanism exists. JIT config pins labels and a runner group, not a
job id. Rejected as impossible.

### Option B — Remove the self-cancel guard (always launch)

Launching for every webhook regardless of run state closes *this* gap but pays
for a VM whenever a run legitimately completes before the delivery delay
elapses, and still leaves the reverse failure (a webhook whose Lambda/SQS
delivery failed outright) unrepaired. Treats a symptom, keeps per-job
accounting that GitHub has already falsified.

### Option C — Pool-level reconciliation (chosen)

Accept that the real invariant is pool-level: *every label-matching job queued
on GitHub past a threshold must have a provision in flight.* The reconciler —
which already sweeps every 2 minutes to reap leaked VMs — gains the symmetric
half: sweep GitHub's queued jobs (across `queued` and `in_progress` runs) for
the configured repos, and re-enqueue a provision for any job queued past
180s whose record is absent — or present but a proven lie (`running` +
still queued on GitHub after a 120s stale window).

## Decision

Option C. The reconciler is the component whose job is already "repair drift
between recorded intent and reality"; GitHub's queue is simply a second reality
to reconcile against. The webhook stays the fast path; the sweep is the
correctness backstop.

Safety posture, mirroring the reaping half:

- **Positive evidence only.** Re-provision solely on a 200 from GitHub showing
  `status=queued` past the threshold. Any API failure → log, sweep nothing,
  never throw (absence of evidence is not evidence of an orphan).
- **Never terminate on suspicion.** A stale `running` record's VM may be
  serving someone else's live job; the record is deleted, the VM is left to the
  platform's max-runtime cap.
- **Idempotent by construction.** A duplicate provision is absorbed by
  control's `beginProvisioning` conditional claim.
- **Never silent.** Each repair emits `OrphanedJobsReprovisioned` (CloudWatch,
  alarmed to SNS like `ReclaimedMicrovms`).

## Consequences

- **Positive:** worst-case orphan latency drops from unbounded (2h38m observed,
  healed only by luck) to ~5 minutes (180s threshold + 2-minute sweep cadence).
- **Negative / accepted costs:** ~4 GitHub API calls per sweep per repo when
  idle (well under rate limits at this scale); only exact `owner/repo`
  allowlist entries are sweepable — `allowedOwners`/`allowAll` deployments have
  no enumerable repo list and keep webhook-only provisioning; a quota-deferred
  job (which also has no record while it waits) can be re-enqueued by the
  sweep, resetting its requeue counter — acceptable, since the job *is* still
  queued and the quota gate re-applies on every attempt.
- **Follow-on decisions this forces:** the attestation table's `jobId` field
  records which job a VM was *minted for*, not which job it *served* — under
  cross-assignment those differ, which any receipt-verification consumer must
  treat as approximate pairing (the runner-name ↔ MicroVM pairing remains
  exact).

## Assumptions to revisit

- GitHub keeps assigning JIT runners pool-wide. If GitHub ever ships
  job-scoped JIT registration, the sweep becomes dead code and per-job
  accounting becomes sound again.
- 180s orphan threshold assumes healthy pickup stays ≪ 1 minute (observed
  median 31s). If image growth pushes boot + registration past ~2 minutes,
  raise the threshold before it double-provisions healthy jobs (harmless but
  wasteful).
- The 50-run page cap per status query assumes backlogs stay small; a fleet
  serving busy repos needs pagination.
