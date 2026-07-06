# Research: Gateway execution model options (for ADR-0001)

> **Provenance:** Produced by a research subagent (Sonnet) on 2026-07-06 as input to
> ADR-0001. **Important caveat:** this analysis was framed on **classic Lambda**
> constraints (no inbound sockets, no duplex, 15-min ceiling). It predates the
> discovery — in the companion constraints brief — that **Lambda MicroVMs** are a
> distinct GA primitive that natively terminates WebSocket/gRPC and runs up to 8h.
> Read it as the "classic Lambda" perspective; ADR-0001 reconciles the two.

---

# Meridian Gateway Execution Models — Trade-off Analysis

## Grounding constraints (classic-Lambda framing)

- 15-minute invocation ceiling, buffered or streaming alike.
- Function URLs are HTTP(S) request/response only; RESPONSE_STREAM streams the response out but the request is delivered buffered. No duplex on a Function URL.
- No invocation affinity: nothing routes a second request from the "same session" to the same environment. Cross-request state must live outside (DynamoDB).
- No external handle on a specific in-flight invocation; EventBridge/Scheduler cannot reach into a running invocation. Liveness is only knowable via self-reported heartbeats.
- Response streaming bills wall-clock even while idle-waiting, plus a data-transfer dimension.

## Option 1 — HTTP request-scoped decision engine
Session continuity is synthetic: every request carries a token, each invocation reads DynamoDB, decides, acts, forgets. Lifecycle fit weakest (nothing to "suspend"). Latency pays cold-start + DynamoDB + fresh downstream handshake per request. Cost scales with request count, not session count. Breaks for ordered low-latency duplex (SSH/gaming/non-HTTP TCP). Honest only as a *stateless per-request regional relay with policy*, not a "session."

## Option 2 — Response-streaming egress
Real continuity but bounded to 15 min; DynamoDB read once at start, heartbeats during. Best lifecycle fit of the three because Lambda *forces* the boundary (must emit Suspending ~13-14 min). One handshake amortized, but a visible reconnect seam every ~15 min. Cost = wall-clock billed even when idle + data transfer (closer to renting a small box in 15-min increments). Breaks: hard 15-min wall, no duplex (request not live-streamed in), HTTP-shaped one-directional flows only (download, SSE, log tail). Most literally "Lambda carries live bytes," but narrow.

## Option 3 — Lambda as control/decision plane only
Continuity lives wherever the data path runs (client agent / other compute / managed networking). DynamoDB stores decision/credential state only — fully accurate to "intent not connections." Lifecycle events describe the *external* thing. Latency: Lambda only at setup + re-auth (tens of ms). Cost lowest/cleanest — unless "elsewhere" is a self-run always-on fleet, which reintroduces what the project is avoiding. Doesn't break a Lambda constraint (avoids all). Least honest for "Lambda as gateway."

## Missing options
- **Option 4 — Hybrid: client-side agent + Lambda decision plane.** Local agent (SOCKS/embedded SDK) makes per-flow direct-vs-region choice and holds the real connection; Lambda mints short-lived scoped decisions/credentials at setup + re-auth, reacts to EventBridge, reconciles DynamoDB intent vs agent heartbeats. Option 3 with "elsewhere" = the client's own device. Matches "most traffic direct, only selected destinations routed."
- **Option 5 — API Gateway WebSocket + Lambda.** API Gateway holds the duplex socket; Lambda per-message with `connectionId` as DynamoDB key. Genuine low-latency duplex, clean lifecycle mapping, but only carries application messages you frame over WS — arbitrary TCP still needs encapsulation. Best as the **control/signaling channel**, not bulk data path.
- **Option 6 (not viable alone) — Lambda extension warm process.** Persistent process/pool across invocations of the *same warm container*; can't be a session's durable data path (no container affinity). Cold-start/pool optimization only.
- **Also noted — managed AWS networking** (Global Accelerator / PrivateLink / VPC Lattice) as the data path: same "Lambda not in data path" honesty tax, but managed primitives instead of self-run compute.

## Preliminary ranked recommendation (classic-Lambda framing)
1. **Option 4** (hybrid agent + Lambda decision plane) — best fit for "intent not connections" and Lambda's real model; thesis reframed to "Lambda is an ephemeral, regionally-aware authorization/routing broker."
2. **Option 3** (generalized control-plane-only) — same, ranked below 4 for being unspecified about the data path.
3. **Option 5** (API GW WebSocket) — best as a complement for the control/signaling channel.
4. **Option 2** (response-streaming) — narrow, explicitly-bounded HTTP-shaped mode under 15 min.
5. **Option 1** (request-scoped) — useful only as the *shape* of the decision API the others call.

**Core judgment (classic framing):** the defensible research contribution is not "Lambda holds a socket" but "Lambda is an ephemeral, regionally-placed, event-driven *authority* over selective egress, with DynamoDB as pure intent and EventBridge as the lifecycle spine, while bytes move through infrastructure suited to holding connections." *(ADR-0001 revisits this in light of MicroVMs, which may reopen the 'Lambda holds the socket' option honestly.)*
