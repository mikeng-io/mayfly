# AWS resource ledger — Mayfly Phase 2 spike

**Account:** 163703054402 (`user/mike.ng`) · **Region:** ap-northeast-1 (Tokyo) · **Started:** 2026-07-09

> Live record of everything created **directly in AWS** for this spike, so teardown never
> requires CloudTrail archaeology. Updated as we go. Cost intent: minimal, torn down after.

## Resources CREATED (things to destroy)

| # | When (2026-07-09) | Resource | Created by | Est. cost | How to destroy |
|---|------|----------|-----------|-----------|----------------|
| 1 | 15:31 JST | **CDKToolkit** CFN stack, ap-northeast-1 (staging S3 bucket, ECR repo, IAM roles) | `cdk bootstrap aws://163703054402/ap-northeast-1` | ~$0 (empty) | delete the `CDKToolkit` CloudFormation stack (or keep — standard CDK) |
| 2 | 15:33 JST | **MayflySpikeStack** CFN stack: S3 bucket `mayflyspikestack-artifactbucket7410c9ef-zn44dfsrfsja` + IAM role `MayflySpikeStack-MicrovmBuildRoleA8840453-sx3Z9kGH6uQg` + an auto-delete Lambda | `cdk deploy` | ~$0 | `cd infra && npm run destroy` |
| 3 | 17:02 JST | MicroVM **image** `mayfly-diag` (arn:…:microvm-image:mayfly-diag) — building | `aws lambda-microvms create-microvm-image` (no --hooks; the --hooks shorthand caused a bogus 403) | snapshot storage | `aws lambda-microvms delete-microvm-image --image-identifier mayfly-diag --region ap-northeast-1` |
| 4 | 17:3x JST | MicroVM **run** `microvm-0abca5c5-9571-3ac8-a466-75c660cc8a96` (SAFE experiment) — **terminated** | `run-spike-aws.sh` | ~few ¢ | already terminated (manually — a `set -u` bug skipped the auto-terminate; killed via `terminate-microvm`) |

| 5 | 2026-07-09 pm | MicroVM **image** `mayfly-docker` (Docker-in-MicroVM spike, `additionalOsCapabilities=ALL`) — building | `spike/phase2b-docker/docker-spike.sh` | snapshot storage | `aws lambda-microvms delete-microvm-image --image-identifier <arn> --region ap-northeast-1` |
| 6 | 2026-07-09 pm | MicroVM **run** ×1 (docker job) — auto-terminated on script exit | `docker-spike.sh` | ~few ¢ | auto-terminated (trap EXIT INT TERM) |

*Notes:*
- *`mayfly-runner` image was NOT created (the --hooks call 403'd before creating anything). `mayfly-diag` + `mayfly-docker` exist.*
- *HAZARD run created no MicroVM (param error: idle min is 60s, not 45).*
- *`mayfly-diag` image still exists → delete when done (teardown checklist).*

## RESULTS ✅

**Phase 2 — Unknown #2 RESOLVED.** SAFE run: MicroVM stayed **RUNNING** t=10→140s while a real GHA
job (120s sleep) ran to **completed/success**, via the L7 endpoint (`health 200`, `jit 202`). A real
Lambda MicroVM holds a runner through a job when auto-suspend is off.

**Phase 2b — Docker-in-MicroVM WORKS (first try).** `dockerd` ran inside the MicroVM
(`additionalOsCapabilities=ALL`); the job did `docker version` (linux/arm64), `docker run hello-world`,
`docker build` (Successfully tagged mayfly-test), and ran the built image → **completed/success**.
Arch = **aarch64 (ARM64/Graviton)** — native ARM builds; x86 needs buildx+QEMU.

**ARM64 real-workload check — no friction.** A minimal Astro app (Vite/esbuild/Rollup native deps)
did `setup-node` → `npm install` (329 pkgs, no arch errors) → `astro build` → **completed/success**
on the ARM64 runner. Confirms normal npm/JS builds have no arch friction (the only edge — stale-
lockfile npm optional-deps bug — is ecosystem-level, not Mayfly-specific).

**Live compute: none** — all MicroVMs TERMINATED. Two images remain (`mayfly-diag`, `mayfly-docker`)
= tiny snapshot storage → delete on teardown.

## Read-only calls so far (no resources)
- `sts get-caller-identity` — verified identity.
- `lambda-microvms list-microvms` — **failed**, local AWS CLI too old (2.1.2) to know the service.

## Cost watch
- CDK bootstrap → a standing `CDKToolkit` stack (S3 assets bucket, ECR repo, roles) — ~$0, but persistent.
- Spike stack → empty S3 bucket + IAM role — ~$0.
- MicroVM **image** → snapshot storage (~$0.08/GB-month) while it exists → **delete after**.
- MicroVM **runs** → 2 short runs (hazard + safe, ~4–5 min each) → a few cents; auto-terminated on exit.

## Teardown checklist (run when done)
- [ ] `terminate-microvm` any running/suspended MicroVMs (`lambda-microvms list-microvms`)
- [ ] delete the MicroVM image (snapshot storage) — `lambda-microvms delete-microvm-image`
- [ ] `cd infra && npm run destroy` (removes the spike bucket + role)
- [ ] (optional) delete the CDKToolkit stack if you don't want CDK bootstrapped in Tokyo
- [ ] rotate the GitHub PAT (fragment was pasted in chat)
