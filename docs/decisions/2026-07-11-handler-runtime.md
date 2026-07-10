# ADR: Lambda handler runtime — TypeScript / Node 20

- **Date:** 2026-07-11
- **Status:** Accepted
- **Scope:** the control-plane Lambda handlers (`app/src/handlers/*`). Not the CDK (mandated TS) or the in-VM launcher (Go).

## Decision

The webhook, control, and reconciler Lambdas are **TypeScript on Node 20 (ARM64)**.

## Context

Three separate language choices exist and are often conflated:
- **CDK / infra** → TypeScript (a hard project constraint, not evaluated here).
- **In-VM launcher** → Go (static binary, zero runtime deps *inside* the MicroVM — a different concern).
- **Lambda handlers** → the subject of this ADR.

## Rationale

- **One language for the whole control plane.** Handlers and CDK share TS: one toolchain, one linter, one
  test runner (vitest across both packages), and shared types (`types.ts` — `JobRecord`, `ControlMessage`).
  A Python handler in a TS-CDK repo means two toolchains for a solo maintainer.
- **`NodejsFunction` bundling is first-class** in a TS CDK app (esbuild, tree-shaking, one construct).
  `PythonFunction` is alpha and needs Docker to bundle deps.
- **The workload is pure async I/O**, not compute: HMAC → GitHub REST → `lambda-microvms` SDK → DynamoDB/SQS.
  No CPU-bound work, so no language wins on performance. Node's async model fits directly.
- **Cold start** for bundled ARM64 Node is fast — fine for a webhook that must 2xx quickly.

## Consequences / caveats

- The new `@aws-sdk/client-lambda-microvms` is **not** in the Node 20 base runtime, so it must be bundled
  (`bundleAwsSDK: true`). This is a Node-shaped instance of a runtime-agnostic question ("is the new SDK
  client in the base runtime?") — Python would face the analogous botocore-lag/layer problem.

## Alternatives considered

- **Python** — equally reasonable (boto3 is the most mature AWS SDK). Pick it if the team is Python-first
  and accept the two-language repo + `PythonFunction` Docker bundling.
- **Go** — smallest/fastest artifacts, and already used for the launcher. A real option to unify *all
  runtime code* on Go (handlers + launcher), leaving infra in TS. The one alternative worth reconsidering
  if launcher-language consistency is valued over infra-language consistency.
- **Rust** — best perf, overkill for I/O glue.
