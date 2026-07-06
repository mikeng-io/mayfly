# ADR-0001: Gateway execution model on Lambda

- **Status:** Proposed
- **Date:** 2026-07-06
- **Deciders:** Lead architect, synthesizing an independent two-model council (Opus + Fable)
- **Bounded contexts touched:** Gateway, Session, Routing, Lifecycle, Configuration

## Context

Meridian's thesis is whether a newly-GA AWS primitive — **Lambda MicroVMs** — can be
orchestrated as *ephemeral regional gateways* for **policy-driven selective egress**:
most traffic goes direct, only selected destinations are routed through a chosen AWS
region. This is explicitly **not** a full-tunnel VPN.

The original brief assumed a "Lambda MicroVM daemon that holds a WebSocket/gRPC
session." Before committing to that, we had to answer one question that everything
else depends on: **what does "gateway" concretely mean on this platform?**

### Verified platform facts (2026-07-06)

Checked against AWS documentation because the primitive postdates the assistant's
training cutoff (full record in [`docs/research/0001-lambda-execution-constraints.md`](../research/0001-lambda-execution-constraints.md)):

- **Lambda MicroVMs** GA 2026-06-22, Firecracker-based. Each MicroVM gets its **own
  dedicated public HTTPS endpoint** natively terminating **HTTP/2, gRPC, WebSockets**
  (per-request JWE auth; no unauthenticated access).
- **Suspend/resume** preserves full memory + disk state; auto-resume on inbound
  traffic; **suspended = zero compute charge** (only snapshot storage).
- **8-hour total-runtime cap** per MicroVM. The **endpoint is 1:1 with the MicroVM**
  (one URL per VM), and each MicroVM holds **8-128 concurrent connections** by size.
  **Session-to-MicroVM cardinality is therefore a design choice, not a platform limit**
  — a MicroVM can multiplex many sessions up to its connection ceiling. (An earlier
  draft asserted "one MicroVM per session"; that was AWS's per-tenant *isolation*
  framing mistaken for a constraint. Corrected in review — see "Session-to-MicroVM
  cardinality" below.)
- **GA regions only:** us-east-1, us-east-2, us-west-2, **ap-northeast-1 (Tokyo)**,
  eu-west-1 (Ireland). **ap-southeast-1 (Singapore) is NOT available** — yet the
  brief's example policy routes `api.openai.com` there.
- **Quotas:** per-region memory **pool** across running *and suspended* MicroVMs
  (~400 GB default); **RunMicrovm 5 TPS**, Resume 5 TPS, Suspend 2 TPS, Terminate
  10 TPS; per-MicroVM connections and bandwidth scale with size.

The decisive discovery: MicroVMs make "Lambda literally terminates the session's
socket" **real**, not a fiction — but only for ≤8h and only in 5 regions. *How many
sessions share a VM is ours to choose* (see "Session-to-MicroVM cardinality").

## Options considered

Full trade-off analysis in [`docs/research/0001-gateway-execution-options.md`](../research/0001-gateway-execution-options.md).

- **A — Per-session MicroVM as the whole gateway.** MicroVM terminates client traffic
  and decides routing. *Breaks selectivity:* the client must send the VM *something*;
  the cleanest "something" is all traffic → drifts toward full-tunnel. The VM cannot
  see direct flows by definition, so it is the wrong place to make the direct-vs-region
  decision.
- **B — Client agent + classic-Lambda decision plane only; no MicroVM in the data path.**
  Proves nothing novel about the GA primitive — it's a credential-minting Lambda plus a
  client that could point at any proxy. This is the *fallback*, not the thesis.
- **C — MicroVM data path + stateless control edge.** Right skeleton, but under-specifies
  where the selective decision is made.
- **D — Control-plane-only; data path in managed AWS networking** (Global Accelerator /
  PrivateLink / VPC Lattice). A fine *product* answer, but it validates those services,
  not MicroVMs — it answers a different research question.

## Decision

**Adopt Model C′: Lambda MicroVMs as the regional egress appliance, a *mandatory*
client-side policy agent as the selective-routing split point, and a stateless
classic-Lambda control edge for placement / auth / reconciliation.** Session-to-MicroVM
cardinality is a configurable axis — **default to a shared per-tenant regional MicroVM
pool**, with per-session dedicated VMs as an opt-in isolation tier (see below).

Both council members reached C′ independently. The single most important reason:
**"selective" can only be decided on the client**, because only the client sees the
full set of outbound flows and can split direct from region-routed. Therefore the
client agent is not optional garnish (as B frames it) nor the whole answer — it is the
policy split point, and the MicroVM physically only ever receives the minority of flows
chosen for region egress. That is the structural guarantee that Meridian is
selective-egress and *cannot* become a VPN even by accident: the direct majority never
touches AWS.

### The C′ architecture, concretely

**Three planes, each with one job:**

1. **Client agent (data-path origin + policy fast-path).** Holds the outer connection —
   one authenticated, multiplexed HTTP/2/gRPC/WS connection to the session's MicroVM
   endpoint, tunneled flows carried CONNECT-style as streams within it. For each new
   outbound flow it matches the destination against the selected-set (from policy) →
   **matched → tunnel to the MicroVM; everything else → direct, never touches AWS.**
2. **MicroVM (regional egress appliance).** A Go process that *genuinely terminates*
   the tunneled connection, **re-validates every proxied flow's destination against its
   baked-in policy version** (the client is untrusted, so this is the authoritative
   enforcement point), egresses to upstream from the chosen region, returns responses.
   By default **one MicroVM serves many sessions** (a shared per-tenant pool, up to its
   8-128 connection ceiling); a session pins to a dedicated VM only when policy demands
   isolation. Disposable and reconstructible; holds no durable session truth.
3. **Control edge (classic Lambda + EventBridge/Scheduler + DynamoDB + SSM).** Places
   MicroVMs, mints JWE auth, runs the reconciliation loop, drives epoch rotation.

**Selectivity is enforced twice:** at the agent (performance) and re-validated at the
MicroVM (authority). This is a correction to the naive single-enforcement design — the
client-side agent cannot be trusted to be the sole gate.

**Session-to-MicroVM cardinality (configurable; default = shared per-tenant pool).**
The endpoint is 1:1 with the MicroVM, but a MicroVM holds 8-128 concurrent connections,
so how many sessions map to one VM is a design axis — not a platform given. The two
ends:

- **Shared per-tenant pool (default):** a small fleet (1-2+ VMs) per region serves many
  sessions as multiplexed connections. New sessions are *connections to an existing
  endpoint*, so they **do not consume the RunMicrovm 5 TPS budget** and do not each pay
  VM overhead. Best utilization; simplest; correct at this project's scale (1-2 VMs
  cover ≤128-256 concurrent connections). Cost: sessions in a pool share a VM's trust
  and blast radius (acceptable within one trust domain; **not** across mutually-untrusted
  tenants), and the pool cannot suspend-to-zero while *any* member session is active, so
  the "idle = free" economics weaken.
- **Per-session dedicated VM (opt-in isolation tier):** 1:1 session↔VM. Buys VM-level
  isolation and per-session suspend-to-zero ("idle session = free"), at the cost of the
  5 TPS launch ceiling, memory-pool pressure (~400 VMs/region), and per-session
  rotation. Selected by policy when a session needs hard isolation.

**Why default to the pool:** for a single trust domain at research scale, per-session
1:1 is premature optimization that imports the launch-rate and pool-quota walls for
isolation nobody demanded. **The crossover is a measurable research output**, not an
assumption: per-session wins at low concurrency + low duty cycle + untrusted tenants;
the pool wins at overlap, scale, and shared trust. The architecture keeps cardinality a
policy knob precisely so the project can *measure* where the line falls rather than
guess. (This decision corrects an earlier draft that hard-coded per-session 1:1.)

**Session = intent, not connection.** The durable record is a DynamoDB item:

```
session_id        (PK)
client_identity   (JWE subject)
requested_region / effective_region
policy_version    (pointer into SSM/policy store — DynamoDB holds the reference, not the body)
desired_state     (ACTIVE | SUSPENDED | DORMANT)
observed_state
microvm_id / endpoint_url
epoch
runtime_budget_consumed / deadline
jwe_key_ref
```

**No field describes a connection.** A session is reconstructed from four facts — who,
which region, which policy, which epoch — and nothing else.

**Lifecycle mapping (EventBridge + Scheduler).** Events update `observed_state`
asynchronously; a Scheduler-driven reconciliation Lambda diffs `desired` vs `observed`
and issues Run/Resume/Suspend/Terminate. The same loop heals crashes, applies region
migrations, and enforces epoch deadlines.

- `GatewayRegistered` → intent written, MicroVM placed, endpoint stored.
- `GatewaySuspending` → short idle → suspend (auto-resume on inbound traffic; no
  control-plane involvement to wake).
- `GatewayResumed` → reactivation bumps `runtime_budget_consumed`.
- `GatewayRotating{session, old, new}` → **8h epoch rotation** (see below).
- `GatewayTerminated` → teardown; pool released; only the DynamoDB row remains.

**8-hour cap = epoch rotation, make-before-break.** Treat MicroVM lifetime as a
*gateway epoch*, rotation as normal operation. At T−5min the control edge runs a
successor MicroVM (epoch N+1) in the same region, writes its endpoint, emits
`GatewayRotating`. The agent dials the successor, then drains. **Outer connection moves
seamlessly; in-flight *inner* TCP/WS flows through the old epoch break and reconnect at
the application layer.** Acceptable because the target protocols (HTTP/2, gRPC, WS) all
have idiomatic reconnect/resume, and the 8h budget is *active* runtime — an idle-heavy
suspended session can span days of wall-clock per epoch. There is **no TCP handoff**;
we do not pretend otherwise.

**Region substitution, enforced at intent-write time, never at runtime.** The control
edge validates `requested_region` against the SSM-published GA list. A policy naming an
unavailable region (e.g. `ap-southeast-1`) gets an **explicit** outcome chosen by the
policy author: `strict` (reject, fail loudly) or `nearest-fallback` (versioned map,
e.g. `ap-southeast-1 → ap-northeast-1`). DynamoDB stores **both** `requested_region`
and `effective_region`. When Singapore GAs, the reconciliation sweep finds
`requested != effective` rows and migrates them at the next epoch rotation. **Silent
fallback with no recorded original intent is forbidden.**

**Memory pool management (applies most sharply to the per-session tier).** For dedicated
per-session VMs, the ~400-VMs/region memory pool is the scale wall, so **termination is
steady state, suspension is a latency optimization**: active → **suspend** for short
idle → **terminate-with-intent** for long idle (pool released; reactivation = fresh
RunMicrovm from intent). Suspended MicroVMs still consume the pool, so "suspend
everything" does not dodge the quota — only reclamation does. For the shared pool tier,
the fleet is instead **sized to concurrent-connection demand** and kept warm during
active hours; scale-to-zero applies to the *whole regional pool* when no session is
active, not per session.

## Consequences

**Positive:**
- The research thesis becomes *testable*: does the MicroVM lifecycle (dedicated
  endpoint, suspend/resume-with-state, auto-resume, scale-to-zero-with-memory) map
  cleanly onto *session* semantics? C′ interrogates exactly that.
- In the **per-session tier**, idle sessions are **nearly free** (suspend = zero
  compute; ~$0.08/GB-mo snapshot) — impossible under Managed Instances (continuous EC2
  +15%) or classic Lambda (can't hold the socket). This is the strongest *novel*
  economic claim, and the reason the per-session tier exists at all. The **shared pool**
  trades this for utilization and simplicity; whether the trade is worth it is the
  cardinality crossover the project should measure.
- Selectivity is structurally guaranteed, not hoped for.
- Per-session billing attribution and blast-radius isolation fall out for free.

**Negative / accepted costs:**
- A **client agent must exist** — Meridian is not purely serverless; there is software
  on the user's machine.
- **In-flight inner flows break at each 8h epoch rotation and at every suspend/resume**
  (remote peers RST idle sockets). Application state survives; sockets do not. Workloads
  needing an unbroken flow for >8h of *continuous activity* are **out of scope**, and we
  say so rather than engineer around it. In the **shared pool** tier this rotation
  batches many sessions onto one VM's 8h boundary — a larger correlated reconnect burst
  — which the pool must stagger (e.g. staggered-age VMs in the fleet) rather than rotate
  in lockstep.
- **RunMicrovm 5 TPS** (300/min/region) is the concurrency ceiling for *new/cold*
  sessions. Correlated reconnect storms (regional recovery, Monday 9am) drain slowly —
  ~2,000 cold sessions ≈ 7 min to one region. Mitigated by warm suspended pools,
  preferring Resume over Run, and token-bucket admission with jittered retry. **We
  quantify this in the writeup rather than hide it.**
- **Bandwidth ceilings** (size-scaled) make bulk-transfer / media a non-starter — fine,
  because the thesis is *selective* API/WS egress.

**Follow-on decisions this forces (future ADRs):**
- ADR-0002: Client agent architecture & the agent↔MicroVM tunnel protocol.
- ADR-0003: Policy model & distribution (SSM vs dedicated policy store; how
  `policy_version` is baked into MicroVM boot).
- ADR-0004: Reconciliation loop & warm-pool / admission-control design.
- ADR-0005: **Session-to-MicroVM cardinality** — shared-pool sizing, the isolation-tier
  policy knob, and the experiment that measures the per-session-vs-pool crossover.
- ADR-000x: Whether **Route53 stays in the architecture at all** (see below).

## Council divergences (recorded, not smoothed over)

1. **Route53 — proposed for removal.** Fable argues Route53 should be **dropped**:
   MicroVM endpoints are minted *after* launch, so DNS cannot perform placement; the
   client must call the control edge regardless; latency-based selection across 5 static
   regions is an SSM lookup table, not a DNS problem. Opus retained Route53 for initial
   placement. **Lead-architect ruling: provisionally scope Route53 OUT of v1** — its two
   stated jobs (discovery, initial placement) are both subsumed by the control-edge call
   + SSM region/latency hints. This **contradicts the original project brief**, which
   named Route53 explicitly, so it is flagged for Mike's ratification before it becomes
   binding (this ADR stays *Proposed*). Revisit only if measured placement quality from a
   static table is poor enough to justify latency-based DNS for the control-edge entry.
2. **Enforcement point.** Adopted Fable's two-point enforcement (agent fast-path +
   MicroVM authoritative re-validation) over Opus's agent-only enforcement.
3. **Framing of the 8h boundary.** Adopted Fable's "epoch rotation, make-before-break"
   over Opus's "successor spawn + drain" — same mechanism, cleaner mental model, with
   Opus's explicit outer/inner-flow distinction retained.

## Assumptions to revisit (kill-criteria)

Merged from both council members. Abandon C′ (fall back to B, or concede the *product*
answer is D) if any of these prove out:

1. **Economics invert:** measured average session duty cycle in the research workload
   exceeds **~20-30%** → Managed Instances / shared Fargate proxies win on $/GB and the
   strongest claim evaporates. *(Individually fatal.)*
2. **Pool exhaustion:** realistic idle distributions exhaust the regional memory pool
   below a few thousand sessions and AWS won't raise the quota → the suspend tier is
   unusable and MicroVMs degrade to "slow Fargate."
3. **Resume latency:** p95 auto-resume/Resume-API reactivation exceeds ~1.5-2s → idle
   reactivation is visibly worse than dialing a fresh shared proxy; both the cost and
   reconstruction stories depend on fast resume.
4. **Rotation pain is real, not theoretical:** measured inner-flow breakage at epoch
   rotation is unacceptable for representative workloads at a frequency users notice.
   *(Individually fatal.)*
5. **Reconnect-storm math fails:** realistic correlated-reconnect traces exceed the
   combined Run+Resume TPS budget such that recovery-to-full-service after a regional
   blip takes >15 min with no quota relief.
6. **The agent is sufficient alone:** if in building it the client agent (pointing at any
   commodity regional proxy) delivers the whole value, the MicroVM adds only constraints
   → collapse to B and admit the MicroVM was never needed.

## What this model actually proves (no overclaiming)

If it works, C′ proves — and *only* proves — that a Firecracker MicroVM with a dedicated
inbound endpoint can serve as a **genuinely connection-terminating regional egress
relay** whose entire lifecycle (placement, suspension, termination, rotation, region
migration) is reconstructable from a small declarative **intent record plus lifecycle
events**. At **per-session** granularity it additionally proves the **scale-to-zero,
idle-is-free** property that makes the MicroVM lifecycle *itself* the session
abstraction — the sharpest and most novel claim, and the one the cardinality experiment
(ADR-0005) exists to confirm or refute. It does **not**
prove "Lambda holds a session": continuity across suspend, terminate, and the 8-hour
epoch is provided entirely by the client agent's re-dial logic; TCP state with remote
destinations is lost at every suspension and rotation; the durable thing is never a
socket — it is a DynamoDB row describing what should exist and where. **The claim is
"intent survives; connections are cheap to rebuild," and the research must be written so
nobody mistakes it for the stronger claim.**
