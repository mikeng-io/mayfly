# Mayfly — Pre-Build Critical Review

- **Reviewer role:** Independent senior AWS/platform architect (adversarial pre-build review)
- **Date:** 2026-07-07
- **Under review:** `docs/superpowers/specs/2026-07-07-mayfly-design.md`
- **Supporting:** `docs/research/github-actions-jit-runners.md`, `docs/mayfly-vs-codebuild.html`
- **Verdict:** **Proceed-with-changes** — buildable, but only after one crux spike lands, and after resolving a positioning contradiction that runs through both documents.

---

## TL;DR

The GitHub Actions plumbing (webhook → SQS → re-check → JIT config → fork-check → reconciler) is well-grounded by the research doc and derivative of proven reference projects — it is the *safe* part. The novel, unverified, potentially fatal part is the MicroVM interaction model: **how a control plane hands a JIT config to a resumed L7-only MicroVM and holds an 8-hour long-poll job through to exit.** The spec hand-waves this as "inject it."

Separately, the two documents disagree about what Mayfly is *for*. The spec stakes everything on **isolation** ("that combination… is the gap"). The companion HTML explicitly says the novel capability is **suspend/resume warm-start at ~zero idle cost** ("what the article is actually about") and draws the isolation row as a near-tie. The verified, demonstrable edge is the cost/latency one; the isolation edge is soft and — critically — **not live-demonstrable**. The team has not decided what it is building.

---

## 1. Technical feasibility red flags (ranked by severity)

### 1a. (CRUX / highest) JIT-config injection + `run.sh` on resume — the spec undersells a custom in-VM agent and an unverified invocation model

The spec's Approach C step 3 reads: "resume it (ms) → attach the network profile → mint a JIT config and inject → runner runs `./run.sh --jitconfig`." The word "inject" is doing enormous, unearned work.

Given the verified platform facts — each MicroVM exposes **only an L7 HTTPS endpoint** (HTTP/2, gRPC, WebSocket, bearer-token auth), **no raw L4 socket, no SSH, no stable inbound IP** — "injecting" a config is not a file drop or an SSH exec. It requires:

1. **A custom in-VM agent** (an HTTP/gRPC server or a long-poll client) already running inside the suspended image, blocked waiting for the JIT blob. The spec never names this component. It is net-new, security-sensitive (it receives credentials-bearing payloads), and must survive suspend/resume in a blocked state.
2. **A resume/invocation model that supports "receive payload, then run for the job's full duration, then exit."** Suspend/resume restores a memory+disk snapshot — the frozen process continues; you cannot "start `run.sh` on resume" as a resume-time hook. So the model must be: agent is pre-blocked → control plane calls the endpoint (platform auto-resumes) → agent unblocks, execs `run.sh --jitconfig` → runner **long-polls GitHub over egress 443 for the entire job** → process exits. Whether a single MicroVM invocation holds open across a multi-minute-to-multi-hour outbound long-poll is **the unverified make-or-break**. The 8h max-runtime cap is *consistent* with long-running invocations, but consistency is not confirmation.
3. **Control-plane → MicroVM reachability** over that L7 endpoint from the control-plane Lambda, with bearer-token auth wired up.

None of these three are established anywhere in the spec or research. This is the single most likely wall. It is correctly listed as risk #1 / first spike (spec line 140), but its framing ("JIT-config injection on resume") badly understates the scope: it is really "does the MicroVM invocation lifecycle support a long-running, control-plane-fed, outbound-only workload at all." **Spike this end-to-end before any warm-pool or reconciler work.** Note the fallback (Approach B, launch-per-job) does **not** escape this — it still needs the same jitconfig-handoff + long-running-invocation semantics; it only drops the *suspended pool*. If the invocation model can't hold the job, both approaches fail.

### 1b. (low risk — reasoning holds) Runner agent inside a MicroVM

This is the *strongest* part of the design. The `actions/runner` agent is **outbound-only** HTTPS 443 long-poll; it needs **no inbound rule** (research doc §3). That maps cleanly onto the MicroVM constraint (L7-only, no inbound IP): runner→GitHub is pure egress via the VPC egress connector; the only inbound path is the one-time jitconfig handoff over the dedicated HTTPS endpoint. Self-clean-and-exit gives the authoritative "done" signal. The reasoning is sound and I'd rate this low-risk *conditional on 1a* — the agent runs fine; the question is only whether the platform holds its invocation open while it does.

### 1c. (high risk — overstated) Egress connector + security-group "governance" does not deliver "reaches only the test DB, nothing else"

Two distinct problems, both underplayed:

- **Security groups cannot do domain allowlists.** They are CIDR + port. But the runner *must* reach a broad, shared set of destinations just to function: `github.com`, `*.actions.githubusercontent.com`, `codeload`, `*.blob.core.windows.net`, `ghcr.io`, package registries (research doc §3). Those live on large, shared CIDR ranges (Azure blob storage, GitHub's ranges, CDNs). Once an untrusted job can egress to those CIDRs, "reaches only the test DB and is blocked from everything else" (spec lines 150-152) is **false** — a hostile job has a wide exfiltration surface through the mandatory allow-list. True domain-level containment needs an egress proxy/firewall (Squid, or a filtering forward proxy) — which is exactly the "regional egress proxy" complexity the project *abandoned* as Meridian. You cannot claim tight egress governance with SGs alone.
- **Can the SG even be varied per job at resume?** The spec treats "attach the network profile" as a resume-time action (spec line 96, 112). If the MicroVM's VPC egress config binds the security group at *deploy/config* granularity (as Lambda VPC config does), you cannot swap SGs per invocation — you would need **separate warm pools per trust profile** (a no-VPC pool for forks, an SG-bound pool for internal). That is a materially different design than "dynamically attach at resume." Verify this; it likely forces pool-per-profile.

The **honest** minimal form is the one the research doc already states (research §4, "What this means for Mayfly"): fork ⇒ **no VPC/no private access**; internal ⇒ SG to the test DB. That protects *your private resources* and is defensible. The spec body (lines 104-117) inflates this back into a "2-3 network profiles… this is the demo, not a deferred extension" pillar that the SG mechanism can't honestly back. Internal tension with its own research.

### 1d. (high risk — honesty) The "container-escape probe" isolation demo is not honestly demonstrable as a live win

The money-shot (spec lines 148-149): "a container-escape-style probe that would cross a shared kernel gets nothing; each job is a fresh VM."

- You cannot ethically or practically run a **real** kernel escape / container breakout (a 0-day) against CodeBuild or a GitHub-hosted runner to show it "succeeding there and failing here." So the demo necessarily collapses to showing *boundary signals*: on Mayfly the probe sees its own kernel, own PID 1, no host mounts, isolated `/proc`; on a container it sees shared-kernel markers, cgroup artifacts, the container runtime. That demonstrates **"this is a VM, that is a container"** — which is true and easy — but it does **not** demonstrate that the isolation *matters*, i.e., that a real escape would have crossed the container boundary. As written ("a probe that *would cross* a shared kernel gets nothing"), it overclaims.
- Worse for differentiation: **fresh-VM/fresh-container-per-job is not unique to Mayfly.** CodeBuild on-demand also gives a pristine ephemeral container per build. So cross-job contamination is *not* a differentiator either. The *only* honest microVM edge is resilience to **kernel-level** escapes — precisely the thing you can't stage as a live "blocked here / escaped there" demo.

Net: the isolation demo is real *in principle* but **hand-wavy as a showcase**. For an article-first deliverable this is a serious problem — the headline demo is the least demonstrable claim.

### 1e. (medium — friction, not a wall) MicroVM IaC/CDK maturity

GA was 2026-06-22 — roughly **two weeks** before this spec. Expect **no L2 CDK constructs**, L1 (`Cfn*`) at best, and quite possibly no CloudFormation coverage at all yet → a **Lambda-backed custom resource** driving SDK calls for create/suspend/resume/warm-pool. The spec flags this (risk #3). It doesn't kill the project but it undercuts the "`cdk deploy` reproduces it" success criterion (line 154) and adds real build cost: suspend/resume + pool orchestration will be imperative SDK code, not declarative CDK. Budget for it.

### 1f. (low/mixed) 8h cap / 5 regions / launch-rate

- **8h cap: non-issue.** GitHub's own per-job limit is 6h; an 8h MicroVM cap comfortably covers any single job. Worth stating explicitly as a non-risk.
- **5 regions: non-issue for a showcase.** Pick a supported region. Only bites production/multi-region — already a non-goal (line 53).
- **Launch-rate / concurrency: minor.** A brand-new GA primitive likely ships conservative account concurrency/burst limits. With a small warm pool N + refill-on-teardown, a demo won't hit them. Could bite under real load, but that's out of v1 scope. Note it and move on.

---

## 2. Positioning honesty

**The thesis as written does not cleanly hold, and the two documents contradict each other on what the thesis even is.**

- **Spec:** isolation is THE gap — "VM-isolated *and* access-governed untrusted-code execution, integrated into GitHub Actions… is the gap" (lines 26-29).
- **Companion HTML:** the CodeBuild isolation comparison is drawn as a near-tie (both get a ✓, "container · shared kernel" vs "microVM · own kernel"), and the doc explicitly states the differentiator is **suspend/resume**: *"Mayfly is the only column with both — fast start and ~zero idle cost… That combination is the novel capability, and it's what the article is actually about."*

These are two different products. Resolve this before building; it changes the demo, the scope, and the article.

Confronting the strongest counter-arguments:

- **Does anyone run genuinely untrusted code in their *own* CI?** Rarely, outside the **fork-PR** case for open-source maintainers. And GitHub already mitigates that heavily: fork PRs from first-time/outside contributors require **maintainer approval** before workflows run, secrets are **withheld from fork PRs** by default, and the `pull_request_target` footgun has explicit "don't check out untrusted code" guidance. For the median team, process controls already neutralize most of this. VM isolation is **defense-in-depth, not a decisive unlock**.
- **The "AI-generated code" framing is the weakest link.** If it's *your* AI agent writing code in *your* pipeline, it is unpredictable/low-quality but **not adversarial** — a container already contains a crashy or greedy process perfectly well. The threat model that *needs a VM boundary* is **actively hostile code trying to escape the kernel** (hostile fork PRs, untrusted third-party artifacts), not "an LLM wrote it." Conflating "AI-authored" with "adversarial untrusted" (lines 9-15, 21-23) inflates the addressable market. Be honest that AI-authorship mostly does **not** require microVM isolation.
- **Why not a raw MicroVM / AgentCore / E2B / Modal sandbox instead of wiring into GHA?** If isolation for untrusted AI code is the goal, a dedicated sandbox is the more natural, already-existing vehicle. The *only* thing that justifies the GHA integration is the narrow "I already have GHA workflows, I take fork PRs, and I want VM isolation without leaving GHA" niche. That niche is genuine but small.
- **Is CodeBuild's per-build container isolation good enough for most?** **Yes** — ephemeral fresh container per build, in your VPC, with IAM/Secrets Manager/CloudTrail built in. The microVM edge only matters against kernel-level escapes, a tail risk most CI operators knowingly accept. The isolation edge is **marginal for the median user**, decisive only for a security-maximalist running hostile code.

**Where the honest, defensible edge actually is:** the **suspend/resume → warm start at ~zero idle cost** curve (a verified platform fact). CodeBuild structurally forces reserved-capacity-idle-cost *or* on-demand-cold-start; a suspend-to-zero MicroVM can offer both. That is real, verified, and *demonstrable* (warm-resume-vs-cold latency + cost). The spec relegates it to "secondary, real but narrower" (line 31) and the *metrics* demo to "(Secondary)" (line 153) — exactly backwards. **Lead with the capability you can prove; treat isolation as defense-in-depth.**

**Is the money-shot compelling?** As currently ordered, no. The two foregrounded demos (isolation, egress governance) are the two softest — one not live-demonstrable (1d), one not achievable with SGs (1c). The one concrete, compelling demo (warm-resume vs cold latency/cost) is backgrounded.

---

## 3. Scope

For an **article-first showcase**, v1 is **too big in the derivative parts and too optimistic in the novel parts**:

- **Over-scoped:** full DynamoDB desired-vs-observed reconciliation, two-phase orphan sweep, multi-profile governance "pillar," and a suspended warm pool with refill. This is production-SRE machinery. Much of it is derivative of the reference projects (which do it on EC2) — building it faithfully is a lot of undifferentiated work for a demo, and none of it de-risks the actual novelty.
- **Under-de-risked:** the genuinely new bits (1a invocation/handoff model, 1c per-job SG feasibility, 1d demo honesty) are where the effort should concentrate first.

**Recommendation:** start from **Approach B** (launch-per-job from snapshot, no suspended pool) not as a "fallback" but as the **de-risking v1 path** — it isolates the crux (jitconfig handoff + long-running invocation) without also betting on suspend/resume pool orchestration and reconciler polish. Add the warm pool + suspend/resume *only after* 1a is proven — and note that suspend/resume is the thing that makes the *cost story* (your real edge) land, so it's worth doing, just second. Right-size governance down to the honest one-boolean the research doc already endorses (fork ⇒ no VPC; internal ⇒ SG to test DB).

---

## 4. Kill / reshape criteria

**Single finding that should stop or reshape before building:**

> **If the MicroVM invocation/resume model cannot (a) accept a control-plane-initiated JIT-config handoff over its L7-only endpoint and (b) hold that single invocation open while the runner long-polls GitHub over egress for the job's full duration, then both Approach C *and* the Approach B fallback are dead in their current form.** Everything else (webhook, SQS, fork-check, reconciler, DynamoDB) is derivative and de-riskable; this is the load-bearing unknown. Verify it with a bare-bones spike (one MicroVM, hand it a jitconfig via the endpoint, watch one real GHA job run to exit) **before** writing any pool, reconciler, or governance code.

**Second, reshape-level finding:** the spec-vs-HTML contradiction over the primary value prop (isolation vs suspend/resume cost). Building before resolving this means building the wrong demo. The evidence points to leading with the cost/latency curve (verified, demonstrable) and demoting isolation to defense-in-depth (soft, not live-demonstrable).

---

## Verdict: **Proceed-with-changes**

Technically plausible and well-grounded on the GitHub side; the AWS/MicroVM side rests on one unverified crux and a demo whose headline claim isn't honestly stageable. It should not start with pool/reconciler/governance code.

### Top 3 things to resolve before building

1. **Spike the MicroVM interaction model end-to-end (kill criterion).** Prove: control plane → L7 endpoint → resume → in-VM agent receives jitconfig → `run.sh --jitconfig` → one real GHA job long-polls GitHub over egress → clean exit, within one held invocation. Name and design the in-VM agent explicitly. If this fails, stop.
2. **Decide and align the thesis.** Isolation vs suspend/resume cost. The verified, demonstrable, structurally-hard-for-CodeBuild edge is the **cost/latency curve** — lead with it. Reframe isolation as defense-in-depth for the narrow hostile-fork-PR niche, and stop equating "AI-authored" with "adversarial untrusted." Fix the spec/HTML contradiction.
3. **Fix the governance claim (and verify per-job SG feasibility).** Security groups can't do domain allowlists, and the runner must egress broadly to GitHub/Azure-blob/registries to function — so "reaches only the test DB, blocked from everything else" is not true with SGs alone. Reduce to the honest one-boolean (fork ⇒ no VPC access), or accept you need a real egress proxy (reintroducing abandoned-Meridian complexity). Separately confirm whether the egress SG can even vary per invocation or forces a pool-per-profile design.
