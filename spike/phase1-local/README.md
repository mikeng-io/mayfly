# Phase 1 crux spike — local, no AWS

**Question this answers (Unknown #1):** can an *in-VM launcher* receive a JIT runner
config over an HTTP endpoint and run one real GitHub Actions job to clean exit?

This runs the actual `actions/runner` inside a **Docker container** (stands in for the
MicroVM on macOS, where local Firecracker isn't available) against the **real** GitHub repo
`mikeng-io/mayfly-test`. It models the production flow: control plane mints a JIT config →
hands it to the in-VM launcher over HTTP → runner runs exactly one job → exits.

**It does NOT test Unknown #2** (does a *Lambda MicroVM* stay running / not auto-suspend
while the runner long-polls and executes) — that needs a real MicroVM (Phase 2).

## Run

```bash
./setup-repo.sh   # once: upload the spike workflow to mayfly-test
./run-spike.sh    # build image, mint JIT, run one job, report
```

Needs `GITHUB_PAT` (Administration:write + Actions) in the repo-root `.env`, and Docker.

## Pass criteria

- container exits **0**
- the workflow run's conclusion is **success**
- the runner **auto-deregisters** after the one job (JIT ephemeral, single-use)
