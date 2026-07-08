# Phase 2 crux spike — real Lambda MicroVM

**Question this answers (Unknown #2 — the make-or-break):** does a real Lambda MicroVM
**stay RUNNING** while the runner long-polls GitHub and executes a job, when the JIT config
is handed to it over the **real L7 endpoint** (`X-aws-proxy-auth`)?

The docs already half-answer it: auto-suspend is driven by **inbound endpoint** traffic, and
the runner talks **outbound**, so a naive idle policy would suspend it mid-job — but AWS says
to *"disable automatic suspension or configure a suitable idle duration"* for async apps. This
spike sets a high `maxIdleDurationSeconds` and confirms empirically that a job runs to success
in a held MicroVM.

All AWS **resources** (S3 artifact bucket + IAM build role) are created via **CDK**
(`infra/`) — nothing is created by hand. The image build/run are imperative operations
driven by the scripts, reading the bucket/role from CDK outputs.

## Prerequisites

- AWS creds in your shell (env vars / `AWS_PROFILE` / `aws sso login`) with permissions for
  `lambda-microvms:*`, S3, IAM, CloudFormation, and CloudWatch Logs.
- `GITHUB_PAT` in the repo-root `.env` (already set from Phase 1).
- The `mayfly-spike` workflow already in `mikeng-io/mayfly-test` (from Phase 1's `setup-repo.sh`).
- A GA MicroVM region — default `ap-northeast-1` (Tokyo). Node + npm for CDK.

## Run

```bash
cp config.env.example config.env      # set AWS_REGION (+ IMAGE_NAME)

cd infra
npm install
npx cdk bootstrap                     # once per account/region
npm run deploy                        # creates bucket + build role -> ../cdk-outputs.json
cd ..

./build-image.sh                      # zip app -> S3 -> create-microvm-image -> wait CREATED
./run-spike-aws.sh                    # run-microvm -> hand JIT over L7 -> watch it run one job
```

`run-spike-aws.sh` terminates the MicroVM on exit (via a trap), so it won't linger and bill.

## Teardown

```bash
cd infra && npm run destroy           # removes the bucket + role (nothing orphaned)
```

## Pass criteria

- MicroVM state stays **RUNNING** throughout the job (never auto-suspends mid-job)
- the workflow run conclusion is **success**
- the launcher `/status` reports `done:true, code:0`

## Open items this may surface (expected spike iteration)

- Whether lifecycle hooks arrive on 8080 or a separate port (launcher listens on both).
- Snapshot compatibility of the Ubuntu app layer with the `al2023` base image (the `.NET`
  runner + OpenSSL) — if it misbehaves, switch the app `FROM` to an AL2023 base.
- The exact `authToken` JSON shape from `create-microvm-auth-token` (the script handles the two
  documented shapes).
