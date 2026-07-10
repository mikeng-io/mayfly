# ADR: Webhook ingress — bare Lambda Function URL for v1

- **Date:** 2026-07-10
- **Status:** Accepted (v1) — **explicitly not the best-practice end state**; upgrade path defined below.
- **Component:** `WebhookFn` + Function URL in `app/infra/lib/mayfly-stack.ts`, handler `app/src/handlers/webhook.ts`.

## Decision

The GitHub `workflow_job` webhook is received by a **Lambda Function URL with `authType: NONE`**.
Authentication is an **HMAC signature** (`X-Hub-Signature-256`) verified in the handler over the raw
(base64-decoded) body; anything without a valid GitHub signature is rejected with 401 before any work.

## Why this is *not* best practice (stated plainly)

A public Function URL with `NONE` auth is **openly invocable by anyone on the internet**. HMAC protects
*integrity/authenticity of the payload* — it does **not** stop an attacker from invoking the endpoint:

- **Open invoke = billing/DoS surface.** Unauthenticated requests still spin up the Lambda (which then
  returns 401). Cost is small per call, but the blast radius is unbounded.
- **No WAF / edge protection.** No managed rules, no rate-based throttling, no bot control.
- **No IP allowlist.** GitHub publishes its webhook source ranges (`GET /meta` → `hooks`); we don't
  enforce them.
- **No custom domain / TLS management** (irrelevant for a webhook, but part of the gap).

For an article-grade "well-architected" reference this bar is not met by the bare Function URL.

## Why we accept it for v1 anyway

- **Scope:** single repo, low volume, internal-ish. The realistic threat is noise, not a targeted flood.
- **Fail-fast handler:** the only work an unauthenticated request triggers is `verify → 401` — tens of
  milliseconds, no DynamoDB, no MicroVM, no SQS. Amplification is minimal.
- **Simplicity has value in a reference:** one line (`addFunctionUrl`) vs. a CloudFront distribution +
  WAF web ACL + OAC wiring. v1 optimizes for a legible end-to-end story; hardening is a named follow-up.
- **Reversible + non-lossy:** the handler reads the v2.0 event shape (case-insensitive headers,
  `isBase64Encoded`) and is **not** coupled to Function-URL specifics, so the upgrade below is near-transparent.

## Risk accepted

Unauthenticated invocations can incur Lambda cost and, at extreme volume, contend for account
concurrency. No data path is reachable without a valid HMAC signature.

## Mitigations available now (levers, not yet pulled)

- **Reserved concurrency** on `WebhookFn` bounds a flood — but a *tight* cap risks dropping a legitimate
  burst (a large matrix fires many `workflow_job` events near-simultaneously, and GitHub does not robustly
  retry failed deliveries). So any cap must be generous; we left it off in v1 to avoid the correctness risk.
- **HMAC fail-fast** (in place) keeps per-invoke cost minimal.

## Upgrade path (the best-practice end state)

**CloudFront + AWS WAF → Function URL via OAC** (recommended):
1. Set the Function URL to `authType: AWS_IAM`.
2. Front it with CloudFront using **Origin Access Control (OAC)** so CloudFront SigV4-signs origin
   requests — the Function URL becomes reachable **only** through CloudFront, never directly.
3. Attach a WAF web ACL: AWS managed rules + a **rate-based rule** + an optional **IPSet limited to
   GitHub's `hooks` ranges** (`GET /meta`).
4. Keep HMAC in the handler as defense-in-depth.

Alternative: CloudFront + WAF → API Gateway **HTTP API** (HTTP API can't take WAF directly, so CloudFront
is still required); or a REST API (v1) + regional WAF (pricier). None avoid CloudFront if you want WAF.

**Cost of the upgrade:** ~$5/mo WAF web ACL + rules, plus CloudFront request cost. Small, and the
difference between "demo" and "reference." Ship it before any real multi-repo / public exposure.
