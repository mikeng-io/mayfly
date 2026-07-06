# Research: AWS Lambda execution model constraints (for ADR-0001)

> **Provenance:** Produced by a research subagent (Sonnet) on 2026-07-06 as input to
> ADR-0001 (gateway execution model). Claims about **Lambda MicroVMs** and **Lambda
> Managed Instances** postdate the assistant's training cutoff and were independently
> verified against AWS documentation before ADR-0001 was drafted — see the
> "Verification" note at the end of this file. Treat the sourced URLs as the record.

---

# AWS Lambda Execution Model — Factual Brief for Meridian (Regional Session Gateway on Lambda MicroVM)

*Current as of July 2026. All claims sourced to AWS documentation.*

**Key framing note:** AWS now has *three* distinct Lambda compute primitives with materially different execution models. This matters because Meridian's target — "Lambda MicroVM" — is a real, separate AWS service (GA June 2026), not classic Lambda functions:

| Primitive | Model | Max duration | Source |
|---|---|---|---|
| Lambda functions (classic) | Freeze/thaw between invocations, 1 request per environment (on-demand) | 15 min | Lambda quotas |
| Lambda Managed Instances | Continuous execution environment on customer-owned EC2, multiple concurrent invocations per environment, no freeze | Per-invocation timeout only; environment runs continuously | Managed Instances execution environment |
| **Lambda MicroVMs** | Firecracker VM per session/tenant, dedicated HTTPS(+WS/gRPC) endpoint, suspend/resume with full memory+disk snapshot | 8 hours (28,800s) total runtime | MicroVMs guide |

## 1. Invocation & lifetime

- **Classic:** 900s (15 min) hard cap. Init -> Invoke -> Shutdown; environment frozen after invoke. Background goroutines are frozen mid-flight and only resume if the same container is reused (no guarantee). Environments recycled every few hours regardless. Cold starts <1% of invocations, ~100ms-1s.
- **Managed Instances:** environment remains continuously active, no freeze between invocations, parallel processing per environment; per-invocation timeouts apply.
- **MicroVMs:** restored from snapshot including all running processes on resume; up to 8h total runtime per MicroVM.

## 2. Inbound connectivity

- **Classic Lambda cannot accept a raw inbound TCP/WebSocket/gRPC listener socket.** Paths in: Function URLs (HTTPS req/resp or streamed response), API Gateway (HTTP/REST, or WebSocket bridge), ALB (HTTP req/resp only).
- **API Gateway WebSocket bridge holds the socket, not Lambda.** Routes: `$connect`, `$disconnect`, `$default`/custom. Lambda invoked per event/message; push-back via `@connections`/PostToConnection keyed by `connectionId`. API Gateway caps: 1001 close on 10-min idle or 2-hour max lifetime.
- **MicroVMs (the exception):** each MicroVM gets a unique public HTTPS endpoint natively supporting **HTTP/1.1, HTTP/2, WebSockets, gRPC, SSE**, proxied to a port inside the VM (default 8080; routed via `X-aws-proxy-port` / WS subprotocol). Per-request JWE auth (`X-aws-proxy-auth`) scoped to MicroVM ID, allowed ports, expiry; no unauthenticated access.

## 3. Response streaming (Function URLs / InvokeWithResponseStream)

- Buffered response cap 6 MB; streamed cap 200 MB. Bandwidth uncapped for first 6 MB then 2 MBps.
- **Unidirectional (server -> client) only.** Native support: Node.js managed runtimes only; others need custom runtime / Lambda Web Adapter. Billed for full duration even if client disconnects. Function URL streaming unavailable inside a VPC (must use InvokeWithResponseStream via interface VPC endpoint).

## 4. Warm-keeping & startup

- **Provisioned concurrency:** pre-inits N environments (double-digit ms), still discrete req/resp; environments still recycled; extra GB-s charge.
- **SnapStart:** Firecracker snapshot of init'd env. Supported 2026: Java 11+, Python 3.12+, .NET 8+. **No Go, no Node.js.** Network connections from Init not guaranteed to survive restore.
- **Managed Instances:** continuous EC2-backed env, EC2 Savings Plans/RI pricing (~72% off) + 15% management premium.
- **MicroVMs:** suspend/resume preserves full memory+disk via `/run` `/suspend` `/resume` `/terminate` hooks; suspended = no compute charge, only snapshot storage; auto-resume on inbound traffic; 8h total runtime cap; one MicroVM per session (no in-place multiplexing).

## 5. Egress / networking

- Non-VPC Lambda: public internet egress by default.
- VPC-attached: no internet without NAT Gateway / VPC endpoint. Hyperplane ENIs shared per subnet+SG; ENI reclaimed after 14 days idle; don't rely on ENI persistence.
- **Stable regional egress IP:** NAT Gateway + Elastic IP; one static IP per NAT GW (recommend one per AZ for HA -> a small enumerable set, not one).
- **MicroVMs:** public egress by default; private VPC reach via customer-managed VPC egress connector (immutable per MicroVM, reusable). Inbound bandwidth scales with size (0.5GB/0.25vCPU -> 1 MB/s; 8GB/4vCPU -> 16 MB/s).

## 6. Scaling & cost dimensions

- **Classic:** 1 concurrent request per environment; default 1,000 concurrent/region; burst 1,000 env / 10s. Cost: $0.20/M requests + GB-s ($0.0000166667 x86 on-demand); provisioned concurrency $0.0000041667/GB-s.
- **MicroVMs:** per vCPU-second ($0.0000276944 ARM) + per GB-second ($0.0000036667); active burst only (up to 4x); snapshot storage $0.08/GB-mo; suspend/resume ops priced per GB; suspended = zero compute. Account quota = total memory pool across running+suspended MicroVMs/region (e.g. 400 GB default). API rate limits: RunMicrovm 5 TPS, Suspend 2 TPS, Resume 5 TPS, Terminate 10 TPS. Per-MicroVM connection limits scale with size (8 at 1 vCPU -> 128 at 16 vCPU).
- **Managed Instances:** $0.20/M + EC2 pricing + 15% premium.

## 7. Notable 2024-2026 changes

- **Lambda MicroVMs** announced 2026-06-22: per-session isolated environments, native WS/gRPC/HTTP2/SSE ingress, suspend/resume snapshot, 8h cap. Almost certainly the literal target of Meridian's "regional session gateway on Lambda MicroVM."
- **Lambda Managed Instances** announced re:Invent 2025: continuous non-freezing environments on customer EC2.
- **SnapStart** expanded to Python 3.12+/.NET 8+ (still no Go/Node).
- **Durable Functions:** checkpoint/wait/resume up to 1 year; workflow extension, not a socket daemon.

---

## HARD CONSTRAINTS (kill the naive daemon-gateway design)

1. Classic Lambda cannot hold an inbound raw TCP/WebSocket/gRPC listening socket.
2. 15-minute hard ceiling on any single classic invocation.
3. Freeze/thaw -> no reliable background daemon; environments recycled every few hours.
4. API Gateway WebSocket holds the socket, not Lambda; caps at 10-min idle / 2-hour lifetime.
5. Function URL / response streaming is server->client only, and unavailable for VPC Function URLs.
6. Provisioned concurrency / SnapStart reduce cold start but don't create a persistent process; SnapStart has no Go support.
7. Classic scaling unit is 1 concurrent request per environment; no in-process multiplexing.
8. VPC Lambda has no egress without NAT; a single regional static IP isn't native (per-AZ NAT EIPs = a set).
9. MicroVMs cap at 8h total runtime; one MicroVM per session (endpoint is 1:1, no cross-MicroVM LB from one endpoint).
10. Streamed response bandwidth caps at 2 MBps after first 6 MB.

## CAPABILITIES WE CAN EXPLOIT

1. **Lambda MicroVMs are the closest AWS primitive to the "regional session gateway" as literally named** — per-session VM, own HTTPS endpoint terminating WS/gRPC/HTTP2/SSE against the app inside.
2. **Suspend/resume with true memory+disk snapshot** — pause for free, resume with state, auto on inbound traffic. Maps onto session idle/reactivation.
3. **Managed Instances** — continuous non-freezing env + EC2 commit pricing; fits an always-on control/fan-out layer.
4. **API Gateway WebSocket `@connections`/PostToConnection** — decouples "who's invoked" from "who receives," for a stateless control edge.
5. **Function URL response streaming** (200 MB, first 6 MB uncapped) — legitimate server-push per invocation for SSE/telemetry.
6. **NAT Gateway + Elastic IP per AZ** — small, enumerable, stable regional egress IP set for allowlisting.
7. **Hyperplane ENI sharing** — low VPC-attach overhead when fanning out per-session backends.
8. **MicroVM vertical burst (4x)** — absorb spikes without permanent peak provisioning.
9. **SnapStart / provisioned concurrency** — still useful for the stateless auth/routing/session-lookup functions around the gateway.

---

## Verification (2026-07-06)

The pivotal Lambda MicroVM claims were independently checked against AWS sources
(the subagent's assertions postdate the assistant's training cutoff):

- **Exists / GA:** Announced 2026-06-22. Firecracker-based.
  ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/),
  [launch blog](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/),
  [product page](https://aws.amazon.com/lambda/lambda-microvms/))
- **Per-MicroVM endpoint + protocols:** dedicated HTTPS URL supporting **HTTP/2,
  gRPC, and WebSockets** — CONFIRMED.
- **Suspend/resume:** memory + disk state preserved; `suspend-microvm` /
  `resume-microvm` APIs and lifecycle policies; auto-resume on inbound traffic — CONFIRMED.
- **Max runtime:** up to **8 hours** total — CONFIRMED.
- **Region availability (GA):** us-east-1, us-east-2, us-west-2, **ap-northeast-1
  (Tokyo)**, eu-west-1 (Ireland) — CONFIRMED. **ap-southeast-1 (Singapore) is NOT
  in the GA region set.** The brief's example policy routing `api.openai.com` to
  `ap-southeast-1` is therefore not directly realizable on MicroVMs today; ADR-0001
  and the routing model must treat the enabled-region set as a hard input.

Net: the constraints brief's MicroVM capabilities are accurate. The one correction
is region availability, which the options brief did not account for.
