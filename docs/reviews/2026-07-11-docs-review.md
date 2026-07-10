# Docs review — post ADR-consolidation accuracy pass (2026-07-11)

Adversarial review of Mayfly's technical docs after `docs/decisions/` was folded into
`docs/adr/`. Scope: technical/stack accuracy, cross-doc consistency, dead references.
Claims were checked against the actual code (`app/src`, `app/infra`), not assumed.

**Verdict: fix-a-few.** The ADR consolidation itself is structurally clean and the README
core is accurate, but two living status docs (`docs/PROJECT-STATUS.md`, `app/AWS-LEDGER.md`)
still carry pre-deploy "not done yet" language that now contradicts the flagship
"deployed & verified live" claim, plus two leftover old-naming references from the merge.

Legend: **CONFIRMED** = I verified against code/filesystem. **PLAUSIBLE** = judgment call.

---

## 1. [HIGH · CONFIRMED] `docs/PROJECT-STATUS.md` is stale — says the deploy has NOT happened

The whole doc is written from *before* the Phase 6 deploy, directly contradicting
`README.md` ("deployed and **verified live** end-to-end") and `app/AWS-LEDGER.md`
("**VERIFIED LIVE 2026-07-11**").

- `docs/PROJECT-STATUS.md:6-8` — "The only thing between 'code' and 'proven working' is the
  **Phase 6 live deploy**, which is **yours** ... I cannot do that step."
- `docs/PROJECT-STATUS.md:24-35` — "### A. YOURS — the live deploy" with an all-unchecked
  `[ ]` checklist (deploy stack, build image, setup-app, trigger job, teardown).
- `docs/PROJECT-STATUS.md:2` — header claims "Updated 2026-07-11" yet content predates the deploy.

This is exactly the "a doc still saying 'not deployed'" hazard called out in the brief.

**Fix:** Rewrite the TL;DR and Status to "deployed + verified live on ap-northeast-1
(2026-07-11)"; move section A's checklist into a "Done" trail (or mark the items complete),
and drop "which is yours / I cannot do that step."

---

## 2. [HIGH · CONFIRMED] `app/AWS-LEDGER.md` self-contradicts on the live state

The ledger's header now says DEPLOYED/VERIFIED-LIVE, but stale future-tense sections remain
and one line flatly negates the verification block below it.

- `app/AWS-LEDGER.md:12` — "Control plane + demo API deployed to Tokyo (spend authorized).
  **GitHub App not yet created.**" — contradicts `app/AWS-LEDGER.md:29-32`
  "**VERIFIED LIVE 2026-07-11** — GitHub App `mayfly` (id 4267032) installed on
  `mikeng-io/mayfly-demo` ... ran the job to **success** ... teardown terminated the VM."
- `app/AWS-LEDGER.md:34-50` — the "## Task 12 (deploy) — resources this **WILL create** when
  green-lit", "**Gated on:** Mike creating the GitHub App", and "## Teardown checklist (after
  Task 12)" sections are all pre-deploy future tense, superseded by the DEPLOYED table (row 1-3)
  and the VERIFIED LIVE block.
- `app/AWS-LEDGER.md:41` — the "WILL create" list says "SNS `AlarmTopic` + **2** CloudWatch
  alarms (DLQ, reclaim)". The stack actually creates **3** alarms — DLQ, reclaim, **quota-drop**
  (`app/infra/lib/mayfly-stack.ts` `DlqNotEmptyAlarm` / `ReclaimAlarm` / `QuotaDropAlarm`), and
  the ledger's own row 1 correctly says "SNS+3 alarms". Undercount.

**Fix:** Delete "GitHub App not yet created."; collapse/remove the "WILL create" + "Gated on" +
"Teardown checklist (after Task 12)" future sections (or relabel as the executed plan); correct
the alarm count to 3 (DLQ / reclaim / quota-drop).

---

## 3. [MEDIUM · CONFIRMED] README repo-layout still names the removed `decisions/` dir

The consolidation deleted `docs/decisions/` (confirmed gone) and moved ADRs to `docs/adr/`,
but the README's repo-layout tree still lists the old name.

- `README.md` (Repo layout code block): "`docs/           findings · decisions (ADRs) ·
  reviews · runbooks · cost · research`". There is no `docs/decisions/`; the dir is `docs/adr/`.

(The bottom "Docs index" entry `**Decisions (ADRs):** docs/adr/` is fine — the link resolves;
only the label word is legacy. The repo-layout tree is the one that names a non-existent path.)

**Fix:** In the repo-layout block, change `decisions (ADRs)` → `adr (ADRs)`.

---

## 4. [MEDIUM · CONFIRMED] Stale old-style ADR reference survived the merge

The rename `docs/decisions/ → docs/adr/0002-webhook-ingress.md` was not propagated to one
cross-reference, which still uses the old date-named identifier.

- `docs/PROJECT-STATUS.md:41` — "Webhook hardening ... (deferred by ADR
  **`2026-07-10-webhook-ingress`**)". That ADR is now `docs/adr/0002-webhook-ingress.md`.

(Not a path with a `docs/decisions/` prefix, so a path-only grep misses it — but it's the same
stale-naming class the consolidation was meant to eliminate. This was the only such leftover;
repo-wide grep for `docs/decisions` returns zero hits, and the lone `decisions/` grep match in
`docs/attic/research/0001-gateway-execution-options.md:32` is the prose phrase "decision plane",
unrelated.)

**Fix:** → "deferred by **ADR-0002** (`docs/adr/0002-webhook-ingress.md`)".

---

## 5. [LOW · CONFIRMED] Repo-under-test name mismatch: `mayfly-test` (planned) vs `mayfly-demo` (verified)

The planning/runbook docs target `mikeng-io/mayfly-test`; the live verification actually ran on
`mikeng-io/mayfly-demo`.

- Planned: `docs/PROJECT-STATUS.md:30` ("install the GitHub App on `mikeng-io/mayfly-test`"),
  `docs/runbooks/2026-07-11-phase6-deploy.md:3,27,86,105`.
- Verified/real: `README.md:9` (`mayfly-demo`), `app/AWS-LEDGER.md:29,32` (App installed on
  `mikeng-io/mayfly-demo`).

**Fix:** Reconcile — if `mayfly-demo` is the executed target, note the plan said `mayfly-test`
but the live run used `mayfly-demo` (or update the runbook/status to match reality).

---

## 6. [LOW · CONFIRMED] ADR-0001 status: index says "Archived", the file itself says "Proposed"

- `docs/adr/README.md` index row: `0001 | ... | Archived — project pivoted to Mayfly`.
- `docs/attic/adr-0001-gateway-execution-model.md:3`: `**Status:** Proposed`.

The link resolves correctly (attic file exists); only the status label disagrees. Archived docs
often preserve their original status, so this is borderline-by-design — flagging for awareness.

**Fix (optional):** Add an "Archived (superseded by the Mayfly pivot)" note to the attic file's
header, or leave as the preserved historical record.

---

## 7. [LOW · PLAUSIBLE] README Mermaid edge mis-attributes the "completed webhook" source

- `README.md` diagram: `MV -.->|completed webhook| FU`.

The `workflow_job completed` webhook is emitted by **GitHub**, not sent by the MicroVM. The
runner dials GitHub outbound (`MV -->|outbound| GH`, already present); GitHub then posts the
completed webhook to the Function URL. Strictly, the arrow should originate at `GH`
(`GH -.->|completed webhook| FU`). It's a dotted/indirect edge, so impact is low, and the
diagram is **syntactically valid** (see #below).

**Fix (optional):** Re-source the dotted edge from `GH` instead of `MV`.

---

## Verified clean (CONFIRMED — no action)

- **ADR consolidation integrity:** `docs/decisions/` is fully gone; zero `docs/decisions` path
  references repo-wide. `docs/adr/0002` title `ADR-0002: Webhook ingress...` / Status
  `Accepted (v1)`; `0003` title `ADR-0003: Lambda handler runtime...` / Status `Accepted`.
  README index links all resolve (0001→`../attic/adr-0001-gateway-execution-model.md`,
  0002, 0003, template `0000-template.md`, superpowers spec). No dead relative links found.
- **IAM prefix:** `lambda:` (not `lambda-microvms:`) with `lambda:PassNetworkConnector` — matches
  across `app/infra/lib/mayfly-stack.ts` (`MICROVM_ACTIONS`), `docs/findings/...` field notes, and
  `app/AWS-LEDGER.md`. `lambda-microvms` appears only as the SDK/client package name (correct).
- **Pricing consistency:** identical real Tokyo rates in `docs/findings/...` and
  `docs/cost-comparison.md` ($0.0000322421/vCPU-s + $0.0000042688/GB-s; ~$0.0049/min for 2c/4GB;
  wash vs GitHub arm64 $0.005/min; x64-crossover ~290 jobs/mo). No stale "assumed rate" anywhere;
  the per-job/1,000-job table math checks out.
- **README honest claims:** ARM64-only, L7-only, cost-is-a-wash, governance fail-closed — all match
  the code and findings. `app/src/lib/governance.ts` `isAllowed` is genuinely fail-closed (empty
  policy + `allowAll=false` → `false`).
- **README ↔ code architecture:** webhook → SQS(+DLQ, 20s delay) → control Lambda (reserved
  concurrency 5) → DynamoDB claim + RunMicrovm (connectors, auto-suspend off) + JIT over L7 →
  teardown; EventBridge 2-min record-driven reconciler — all match `handlers/{webhook,control,
  reconciler}.ts` and the stack.
- **Stack table + paths:** `app/runtime/` (Go launcher), `app/image/Dockerfile`, `spike/{phase1-local,
  phase2-aws,phase2b-docker}`, `docs/mayfly-cost.html` all exist as referenced.
- **Mermaid validity:** renders as a valid `flowchart` (validated via Mermaid renderer) — will
  render on GitHub.
