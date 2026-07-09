# AWS resource ledger — Mayfly Phase 2 spike

**Account:** 163703054402 (`user/mike.ng`) · **Region:** ap-northeast-1 (Tokyo) · **Started:** 2026-07-09

> Live record of everything created **directly in AWS** for this spike, so teardown never
> requires CloudTrail archaeology. Updated as we go. Cost intent: minimal, torn down after.

## Resources CREATED (things to destroy)

| # | When (2026-07-09) | Resource | Created by | Est. cost | How to destroy |
|---|------|----------|-----------|-----------|----------------|
| 1 | 15:31 JST | **CDKToolkit** CFN stack, ap-northeast-1 (staging S3 bucket, ECR repo, IAM roles) | `cdk bootstrap aws://163703054402/ap-northeast-1` | ~$0 (empty) | delete the `CDKToolkit` CloudFormation stack (or keep — standard CDK) |
| 2 | 15:33 JST | **MayflySpikeStack** CFN stack: S3 bucket `mayflyspikestack-artifactbucket7410c9ef-zn44dfsrfsja` + IAM role `MayflySpikeStack-MicrovmBuildRoleA8840453-sx3Z9kGH6uQg` + an auto-delete Lambda | `cdk deploy` | ~$0 | `cd infra && npm run destroy` |
| — | pending | MicroVM **image** `mayfly-runner` | `build-image.sh` (needs new CLI) | snapshot storage | `lambda-microvms delete-microvm-image` |
| — | pending | MicroVM **runs** ×2 (hazard, safe) | `run-spike-aws.sh` (needs new CLI) | a few ¢ | auto-terminated on exit |

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
