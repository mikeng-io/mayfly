# Meridian — Primary Use Case & User Story

- **Status:** Settled 2026-07-07
- **Feeds:** ADR-0001 (gateway execution model), ADR-0002 (discovery & rendezvous)

> **Project purpose:** Meridian is primarily the subject of a **technical article** on
> a novel architecture unlocked by AWS Lambda MicroVMs. Scope is **article-first** — the
> individual-dev use case below is the article's worked example, chosen for clarity and
> demonstrability, not enterprise scale. Multi-user hardening is explicitly out of scope
> for v1.

## Primary user

An **individual developer**, operating a **self-hosted, single-trust-domain**
deployment (one person / one org boundary — not a multi-tenant SaaS).

## User story

> As a developer, I want *specific* outbound API calls — to providers that must be
> reached from a particular region, or that allowlist a fixed egress IP — to leave from
> a **stable IP in a region I choose**, while **all my other traffic goes direct**,
> without running a full-tunnel VPN.

## Concrete end-to-end flow

1. Dev installs the Meridian agent and writes a TOML policy
   (`match api.X → gateway region R`; everything else `direct`).
2. Agent starts, resolves the **one stable discovery domain** (CloudFront), authenticates.
3. Dev's app calls `api.X`. Agent matches the policy → "route to region R."
4. Agent asks the control plane for a gateway in R **for this user** → an existing or
   freshly-launched MicroVM in R, whose egress leaves via a **stable regional IP**
   (NAT Gateway + Elastic IP). Agent gets `{endpoint, credential}`.
5. Agent tunnels the call to the MicroVM; the MicroVM egresses to `api.X` from the
   stable regional IP; the response returns.
6. All non-matched traffic (GitHub, internal services, everything else) **never touches
   Meridian** — direct from the dev's machine.
7. Idle → the MicroVM **suspends** (zero compute cost). Next matched call auto-resumes
   it. Long idle → terminated; next call relaunches it from DynamoDB intent.

## In scope

- Selective, per-destination regional egress driven by a local policy file.
- A **stable, allowlistable egress IP** per enabled region.
- Serverless economics: nothing running (beyond a DynamoDB row + snapshot) at true rest.

## Non-goals (explicit)

- **Not a full-tunnel VPN.** The default path is direct; only matched destinations route.
- **Not a multi-tenant SaaS** in this iteration. Single trust domain. (Multi-tenant is a
  separate use case — it reintroduces per-tenant isolation and the scale walls; see the
  "Org/team" alternative that was *not* chosen.)
- **Not a DNS-resolver product.** Destination selection happens in the agent from policy;
  target-domain DNS is untouched.
- **Not censorship circumvention / provider-policy bypass.** This is a regional-egress and
  IP-stability tool for legitimate access, allowlisting, and residency needs.

## What this settles for the architecture

1. **Trust:** single domain → **no per-VM isolation requirement**. Per-session dedicated
   VMs are not needed for security.
2. **Cardinality:** **one MicroVM per (user, active region)** — typically 1–2 live VMs,
   suspended when idle. Not per-session; not a large shared pool.
3. **Scale walls deferred:** RunMicrovm 5 TPS and the ~400-VM/region memory pool are
   irrelevant at single-user scale. They return to the table only if Meridian is ever
   taken multi-user.
4. **Stable egress IP is core**, not optional: NAT Gateway + Elastic IP per enabled
   region is part of the value proposition (allowlisting / residency).
5. **Discovery vs. launch:** discovery is an edge concern (CloudFront); launch is an
   origin concern (network-capable control Lambda). See ADR-0002.
