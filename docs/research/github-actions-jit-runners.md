# Research: Ephemeral JIT GitHub Actions runners (for Mayfly)

> **Provenance:** Produced by a research subagent (Sonnet) on 2026-07-07, verified against
> current `docs.github.com`, the `actions/runner` source, and the reference projects
> `github-aws-runners/terraform-aws-github-runner` (formerly philips-labs) and
> `actions/actions-runner-controller`. This is the grounding for the Mayfly implementation
> plan. Runner-per-isolated-VM is our variant; the reference projects use EC2.

---

## 1. The `workflow_job` webhook
- Delivered per-installation to a GitHub App webhook URL; requires the App's **Actions:read**
  permission (separate from the Administration permission used for the runner APIs).
- `action`: `queued`, `in_progress`, `completed`, `waiting`.
- Payload top-level: `action`, `workflow_job`, `repository`, `sender`, optional `organization`,
  `installation` (carries `installation.id` for token minting), `deployment`.
- `workflow_job` fields we use: `id` (job id — primary correlation key), `run_id`, `run_attempt`,
  `name`, `status`, `conclusion`, `labels` (full `runs-on` list, present on `queued`),
  `head_branch`, `head_sha`, and `runner_id`/`runner_name`/`runner_group_id` — **null while
  `queued`**, populated only on `in_progress`/`completed`.
- **Fork-PR detection is NOT in this payload.** Make one extra call
  `GET /repos/{owner}/{repo}/actions/runs/{run_id}` and compare `head_repository.id != repository.id`
  (and `event == "pull_request"`). This is the primary security gate for an isolated-VM pool.
- **HMAC**: header `X-Hub-Signature-256` = `sha256=<hex>` of `HMAC-SHA256(secret, raw_body)` over
  raw UTF-8 bytes; constant-time compare (`crypto.timingSafeEqual`).

## 2. JIT config (use this, not registration tokens)
- `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` (or `/orgs/{org}/...`).
- Body: `name` (our correlation handle — embed job id), `runner_group_id` (`1` = Default),
  `labels` (must include our custom label), `work_folder` (default `_work`).
- Response `201` includes top-level **`encoded_jit_config`** (base64).
- VM consumes it: **`./run.sh --jitconfig <encoded_jit_config>`** — no `config.sh` step;
  credentials are written before contacting GitHub; **inherently single-use** (ephemeral flag baked
  into the JIT payload).
- Legacy contrast: `registration-token` + `./config.sh --ephemeral` + `./run.sh` (older; puts a
  ~1h bearer token on the box). **JIT is preferred** — atomic, nothing leakable on the VM.

## 3. The runner agent
- Install: fetch `actions/runner` release tarball in boot user-data.
- **Outbound-only** over HTTPS 443 (long-poll); **no inbound rule needed.** (Egress allowlist of
  `github.com`, `*.actions.githubusercontent.com`, `codeload`, `*.blob.core.windows.net`, `ghcr.io`,
  etc. — see full list in the source brief.)
- After one job it self-cleans (`DeleteLocalRunnerConfig`) and **exits**. The authoritative
  "done" signal is the **process exit on the VM**, not the `completed` webhook (they race). Add a
  hard-timeout fallback that force-terminates + `DELETE .../actions/runners/{runner_id}`.

## 4. Auth — GitHub App (recommended)
- Permissions: **Repository Administration → write** (this is what grants `generate-jitconfig`,
  `registration-token`, `remove-token`, delete-runner — *not* the Actions permission),
  **Organization Self-hosted runners → write** (if org-scoped), **Actions → read** (to receive
  `workflow_job` and call the runs API for fork detection).
- Token: build RS256 JWT (`iss`=App id, `iat`=now-60s, `exp`≤10m, signed with App key) →
  `POST /app/installations/{installation_id}/access_tokens` → `{token, expires_at}` (1h life) →
  call runner APIs with `Authorization: Bearer <token>`.
- Prefer App over PAT (scoped perms, hourly auto-expiry, higher rate limits, no single-user dependency).

## 5. Label routing
- Workflow opts in with `runs-on: [self-hosted, mayfly]`; arrives verbatim as `workflow_job.labels`
  on `queued`. Matching is cumulative AND, case-insensitive. **Filter before provisioning**: require
  `labels ⊇ {self-hosted, mayfly}`; ignore anything else. Our JIT `labels` must be a superset of the
  requested set.

## 6. Canonical scale-from-zero flow + pitfalls (from the reference projects)
1. **API Gateway → webhook Lambda**: verify signature, filter `action==queued` + label match, publish
   to **SQS with a delay (default ~30s)**. Return 2xx immediately.
2. **scale-up Lambda** (off SQS): **re-check the job is still `queued`** via the API before launching
   (cancellations/other-runner races), enforce max capacity, then provision. Runner name =
   `prefix + instanceId`; correlation stored in SSM (we'll use DynamoDB).
3. Runner boots, pulls JIT config, runs one job, self-terminates.
4. **scale-down / reconcile Lambda** (scheduled): two-phase orphan sweep — mark instances that never
   registered after a grace period, terminate already-marked ones on a later cycle.

**Pitfalls & countermeasures:**
- **`queued` race** → re-check `isJobQueued` at provision time, not just webhook receipt; the SQS delay
  lets fast cancellations resolve.
- **Idempotency** → return 2xx fast, provision async; key idempotency on `workflow_job.id`; re-ask
  GitHub "still queued?" rather than trusting the message.
- **Missed `completed` webhooks** → orphaned VMs; the scheduled reconciliation sweep is **not optional**
  (ARC's own docs: webhook delivery isn't guaranteed; the newer ARC mode dropped webhooks for a
  long-poll listener precisely for this reason). Belt-and-suspenders: VM self-terminate on process exit.
- **Rate limits** → App installation token ~5k–12.5k req/hr; each job costs token-mint (cacheable ~55m)
  + jitconfig + fork-check + reconciliation reads. Emit remaining quota as a metric.
- **Correlation** → persist `{workflow_job.id → runnerName → instanceId}`; `in_progress`/`completed`
  finally expose `runner_name`/`runner_id` to map back for teardown.

## What this means for Mayfly
1. **JIT config**, `./run.sh --jitconfig`, `name` = job id. No token on the MicroVM.
2. **GitHub App** with Administration(write) + Actions(read) [+ org Self-hosted runners(write)]; 1h
   installation tokens minted from the webhook's `installation.id`.
3. **Filter hard on `queued` + `mayfly` label** before provisioning.
4. **Fork detection is mandatory** and becomes our network gate: fork PR → **no VPC security group**;
   internal → the demo SG. (This is the honest minimal form of the access policy — one boolean.)
5. **Three-layer teardown**: (a) MicroVM self-terminates on runner process exit; (b) `completed`
   webhook fast-path; (c) reconciler two-phase sweep. The reconciler is the backbone, confirmed.
6. **Webhook → return 2xx → SQS(delay) → re-check queued → resume/launch MicroVM.** Idempotency on
   `workflow_job.id`.
7. **DynamoDB correlation record** `{jobId → microvmId → runnerName}` is the operational spine.
8. **Track GitHub API quota** as a first-class metric.
