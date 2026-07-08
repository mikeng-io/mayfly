# Phase 1 crux spike — RESULT: PASS ✅

**Date:** 2026-07-08 · repo `mikeng-io/mayfly-test` · runner `v2.335.1` (linux-arm64) · Docker 29.2.1

## What was tested (Unknown #1)
Can an *in-VM launcher* receive a JIT runner config **over an HTTP endpoint** and run one real
GitHub Actions job **to clean exit**, single-use? (Models the MicroVM's L7-only ingress: the
control plane hands the config to an in-VM agent over HTTP, not via SSH/L4.)

## Result — PASS
End-to-end run:
```
control plane → mint generate-jitconfig → POST to launcher (HTTP 202)
[launcher] received JIT config; starting runner for one job
√ Connected to GitHub
Running job: smoke
Job smoke completed with result: Succeeded
√ Removed .credentials / √ Removed .runner      ← auto-deregistered (ephemeral)
[launcher] one job complete; exiting code=0
GitHub run: status=completed conclusion=success
```
Pass criteria all met: container exit **0**, run conclusion **success**, runner **auto-deregistered**
(JIT single-use). Dangling offline runners from failed attempts cleaned up (0 remain).

## What this de-risks
- `generate-jitconfig` + `run.sh --jitconfig <blob>` works with a fine-grained PAT
  (Administration:write). The runner needs **no inbound** — it dials GitHub outbound.
- The **in-VM launcher hand-off over HTTP** is sound — this is the concrete answer to
  "how do you inject the config given the MicroVM's L7-only endpoint."
- Ephemeral single-job lifecycle behaves as designed.

## What this does NOT prove → Phase 2 (real Lambda MicroVM)
- Whether a **Lambda MicroVM stays running (does not auto-suspend)** while the runner long-polls
  and executes the job for its full duration. **This is the remaining make-or-break** and can
  only be tested on a real MicroVM.
- The real MicroVM L7 endpoint + bearer-token (`X-aws-proxy-auth`) hand-off (here modeled with a
  plain container port).
- `run` / `suspend` / `resume` / `terminate` lifecycle behavior with a live runner inside.

## Reproduce
```bash
cd spike/phase1-local
./setup-repo.sh   # once
./run-spike.sh
```
Needs `GITHUB_PAT` (Administration + Contents + Workflows + Actions, all write) in repo-root `.env`.
