# Meridian Reference Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a master plan** for a multi-subsystem build. Per the writing-plans scope
> check, each subsystem gets its own drilled, bite-sized TDD plan when its phase is
> reached; this document fixes the global constraints, the file structure, the phase
> sequence, and the design gates that must close before code. Phase 0 is drilled first.

**Goal:** A deployable, well-architected AWS reference implementation of Meridian — an
ephemeral regional egress gateway on Lambda MicroVMs — demonstrated end-to-end for the
individual-developer use case.

**Architecture:** Client agent (selective split point) tunnels *only policy-matched*
flows to a per-(user,region) Lambda MicroVM that egresses from a stable regional IP;
CloudFront edge does discovery, a control-edge Lambda does launch, DynamoDB holds
session **intent (not connections)**, SSM holds config. See ADR-0001 and `docs/product/use-case.md`.

**Tech Stack:** Go (latest stable) for runtime/control/agent; AWS CDK v2 (TypeScript,
strict) for IaC; CloudFront Functions (JS) for edge; DynamoDB, SSM Parameter Store,
EventBridge Scheduler, S3, Lambda MicroVMs.

## Global Constraints

- **Scope:** article-first, single trust domain, individual-dev use case. NO
  multi-tenant isolation, warm pools, or admission control (explicitly out of scope).
- **Well-Architected bar (hold even if not 100% of best practices):** least-privilege
  IAM per function; encryption at rest (DynamoDB, S3, KVS) and in transit; no hardcoded
  secrets (SSM / Secrets Manager); consistent resource tagging (`project=meridian`);
  structured JSON logs + CloudWatch metrics; **`cdk-nag` (AwsSolutions) must pass or
  carry a documented suppression with justification.**
- **Enabled MicroVM regions (verified GA):** us-east-1, us-east-2, us-west-2,
  ap-northeast-1, eu-west-1. **Demo/primary region: ap-northeast-1 (Tokyo).**
  Unavailable regions resolve via a substitution map at intent-write time.
- **Go quality gate (CI fails on violation):** `gofumpt`, `golangci-lint`, `staticcheck`,
  `govulncheck`. Table-driven tests. Domain logic must not import the AWS SDK
  (Clean Architecture — AWS access only through adapter packages).
- **TS quality gate:** strict `tsconfig`, ESLint + Prettier (single toolchain), CDK
  assertion + snapshot tests.
- **Commits:** frequent, one testable deliverable each; every commit trailer includes
  the Co-Authored-By / Claude-Session lines already used in this repo.

---

## File structure (monorepo)

```
meridian/
  go.work                       # workspace tying runtime/ control/ agent/
  infra/                        # CDK v2 TypeScript app
    bin/meridian.ts
    lib/
      network-stack.ts          # per-region VPC, private subnet, NAT GW + EIP (stable egress IP)
      state-stack.ts            # DynamoDB intent table, SSM config params
      gateway-stack.ts          # MicroVM image (S3), launcher IAM, image build
      control-stack.ts          # control-edge Lambda + reconciler (EventBridge Scheduler)
      edge-stack.ts             # CloudFront dist + Function + KeyValueStore + origin
      meridian-stage.ts         # multi-region stage composition
    test/                       # assertions, snapshots, cdk-nag
  runtime/                      # Go — MicroVM gateway runtime (data path)
    cmd/gateway/main.go
    internal/{tunnel,egress,policy,health,lifecycle}/
  control/                      # Go — control-edge + reconciler Lambdas
    cmd/{resolve,reconcile}/main.go
    internal/{intent,placement,microvm,auth}/     # microvm/ is the only AWS adapter for launch
  agent/                        # Go — client agent (dev machine)
    cmd/meridian-agent/main.go
    internal/{proxy,policy,dialer}/
  edge/discovery.js             # CloudFront Function (JS runtime 2.0, reads KVS)
  docs/{adr,research,product}/                     # decision + research records
```

Bounded-context → module map: Policy→`*/policy`, Routing/Session→`control/intent`+`control/placement`,
Gateway/Lifecycle→`runtime/lifecycle`+`control/microvm`, Runtime→`runtime/*`,
Configuration→`state-stack`+SSM.

---

## Design gates (must close before dependent phases)

- **GATE-A — ADR-0002 (discovery & rendezvous).** Pin: the resolve-or-launch contract;
  the agent↔MicroVM tunnel (proposed: **HTTP/2 `CONNECT`** to the MicroVM endpoint,
  JWE on the CONNECT request, one persistent H2 conn per region, one stream per matched
  flow); client interception (proposed: **local SOCKS5 + HTTPS proxy**, no TUN/root);
  persistent-tunnel vs per-flow-resolve (proposed: **persistent**, re-resolve only on
  rotation/expiry/miss). Blocks Phases 2, 3, 5.
- **GATE-B — CDK MicroVM construct level.** *Partially resolved (2026-07-07):* the
  MicroVM **image** is built from a zip (code + `Dockerfile`) → S3 → Lambda API, and is
  deployable via CloudFormation/CDK (AWS docs confirm CFN/CDK getting-started paths).
  `run/suspend/resume/terminate` are **runtime SDK calls** made by the control-edge /
  launcher Lambda — not static resources — which fits our launch-on-demand model.
  *Remaining:* confirm the exact L1 CFN resource type for the image (fall back to a
  Lambda-backed custom resource if no native L1 exists yet). Not a scaffold blocker;
  resolve in Phase 2. Verify via context7 (`aws-cdk-lib`) + the CloudFormation resource
  reference.

---

## Phase sequence (each phase → its own drilled TDD plan when reached)

### Phase 0 — Scaffold & gates *(drilled first; no design blockers)*
- Monorepo layout, `go.work`, CDK app skeleton that `cdk synth`s empty stacks.
- CI: Go quality gate + `tsc`/eslint + `cdk synth` on push.
- Close GATE-A (write ADR-0002) and GATE-B (verify construct level).
- **Deliverable:** `cdk synth` green, CI green, ADR-0002 Accepted, GATE-B recorded.

### Phase 1 — State & network foundation
- `state-stack`: DynamoDB intent table (PK `session_id`, encryption, PITR), SSM config
  (enabled regions, substitution map, TTLs, policy version).
- `network-stack`: per-region VPC + private subnet + NAT Gateway + **Elastic IP**
  (the stable egress IP), security groups.
- **Deliverable:** CDK assertion tests + cdk-nag pass; `cdk deploy` of foundation in Tokyo.

### Phase 2 — Gateway runtime (Go, in the MicroVM) *(needs GATE-A, GATE-B)*
- Lifecycle hooks (`/run` `/suspend` `/resume` `/terminate`), tunnel acceptor (H2
  CONNECT), egress relay, **policy re-validation** (authoritative enforcement), health.
- MicroVM image build + `gateway-stack` wiring.
- **Deliverable:** image builds; a local integration test drives CONNECT→relay.

### Phase 3 — Control edge (Go Lambda) *(needs GATE-A)*
- `resolve`: placement + region substitution → run/resume MicroVM → mint JWE → write
  DynamoDB intent → write-through KVS → return `{endpoint, credential}`.
- **Deliverable:** unit tests (table-driven placement/substitution); deployed behind origin.

### Phase 4 — Edge discovery
- `edge-stack`: CloudFront dist, `discovery.js` Function (token validate + geo/KVS region
  pick + endpoint lookup), KeyValueStore, origin = control edge.
- **Deliverable:** edge unit tests; KVS-hit fast path + miss→origin fallthrough demonstrated.

### Phase 5 — Client agent (Go) *(needs GATE-A)*
- Local SOCKS5/HTTPS proxy, TOML policy parse+match, resolve via CloudFront, hold H2
  tunnel, CONNECT per matched flow; everything else direct.
- **Deliverable:** agent routes a matched destination through Tokyo, others direct (test).

### Phase 6 — Reconciler
- `reconcile` (EventBridge Scheduler): idle suspend, long-idle terminate/reclaim, epoch
  rotation at ~8h, `desired`↔`observed` diff.
- **Deliverable:** table-driven reconciliation tests; scheduled rule deployed.

### Phase 7 — End-to-end demo & observability
- Deploy Tokyo end-to-end; show a real request egressing from the stable EIP; dashboards/logs.
- **Deliverable:** reproducible demo script + captured evidence of end-to-end behavior.

---

## Self-review

- **Spec coverage:** brief's control-plane services (Route53 dropped w/ rationale in
  ADR-0001; EventBridge/Scheduler→Phase 6; DynamoDB→Phase 1; SSM→Phase 1), runtime
  responsibilities (Phase 2), routing/policy/session (Phases 3/5), lifecycle (Phase 6),
  IaC=CDK (all), linting/testing gates (global constraints) — all mapped.
- **Deferred by design (recorded, not gaps):** multi-tenant isolation, warm pools,
  admission control, heartbeat telemetry — out of article-first scope.
- **Open before deep code:** GATE-A (ADR-0002) and GATE-B (construct level) — Phase 0.
