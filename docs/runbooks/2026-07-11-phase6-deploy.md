# Runbook — Phase 6: deploy + live integration (Mayfly control plane)

- **Account:** 163703054402 · **Region:** ap-northeast-1 (Tokyo) · **Repo under test:** `mikeng-io/mayfly-demo`
- **Cost:** a few cents (short MicroVM runs) + tiny snapshot storage while the image exists + ~$0 idle infra + ~$0.40/mo per Secrets Manager secret. Net footprint after teardown ≈ $0.
- **Everything is CDK-managed** — no manual AWS resource creation. Record anything live in `app/AWS-LEDGER.md`.

> This is the one gated phase (it spends money and needs a GitHub App). Steps 1–4 are the happy path;
> each has a **Verify** gate — do not proceed past a failed gate.

---

## 0. Preconditions (check once)

```bash
# Right account? MUST be 163703054402 (ambient creds have been a different account before).
aws sts get-caller-identity --query Account --output text
# CLI knows the service? MUST be >= ~2.28 (lambda-microvms GA'd 2026-06-22).
aws --version
# Tooling
node --version   # >= 20     docker version     jq --version     zip -v >/dev/null && echo zip-ok
# CDK bootstrapped in Tokyo? (CDKToolkit exists from the spike.)
aws cloudformation describe-stacks --stack-name CDKToolkit --region ap-northeast-1 --query 'Stacks[0].StackStatus' --output text
```

- [ ] Account = 163703054402
- [ ] AWS creds present in repo `.env` (sourced by `build-image.sh`)
- [ ] `mikeng-io/mayfly-demo` has a workflow with `runs-on: [self-hosted, mayfly]` (e.g. reuse `spike/phase2-aws/workflows/mayfly-spike.yml`)
- [ ] **GitHub PAT rotated** (a fragment was pasted in chat earlier — still pending)

---

## 1. Deploy the stack

```bash
cd app && npm ci          # REQUIRED: NodejsFunction bundles @aws-sdk/* from app/node_modules
cd infra && npm ci
npm run deploy            # cdk deploy --require-approval never --outputs-file ../cdk-outputs.json
```

> The Lambdas bundle the AWS SDK into the artifact (`bundleAwsSDK: true`) because
> `@aws-sdk/client-lambda-microvms` isn't in the Node 20 runtime. `app/node_modules` must exist
> (the `cd app && npm ci` above) or esbuild can't resolve it.

Creates (all destroyed by `npm run destroy`): DynamoDB `JobsTable` (+`state-index`), SQS `JobsQueue`+`JobsDLQ`,
SSM params (`/mayfly/{webhookSecret,appId,installationId}`), Secrets Manager `/mayfly/appPrivateKey`,
SNS `AlarmTopic` + 3 alarms (DLQ, reclaim, quota-drop), 3 Lambdas (webhook+Function URL, control, reconciler), EventBridge 2-min rule,
S3 `ArtifactBucket`, `MicrovmBuildRole`.

**Verify**
- [ ] `aws cloudformation describe-stacks --stack-name MayflyStack --region ap-northeast-1 --query 'Stacks[0].StackStatus' --output text` → `CREATE_COMPLETE`
- [ ] `app/cdk-outputs.json` exists with `WebhookUrl`, `ArtifactBucketName`, `BuildRoleArn`
- [ ] **Record the stack in `app/AWS-LEDGER.md`.**

---

## 2. Build the runner image

```bash
cd ../          # -> app/
./build-image.sh          # lean runner; IMAGE_NAME defaults to mayfly-runner (matches the stack)
```

Zips {Dockerfile, runtime/launcher} → S3 → `create-microvm-image` → polls to `CREATED` + version `SUCCESSFUL`.

**Known unknown:** the MicroVM `/ready` build-hook flags. The spike built without `--hooks`; if the build
hangs/fails on readiness, confirm the flag once against `aws lambda-microvms create-microvm-image help`
(search: hook, port) and re-run with e.g.
`export MAYFLY_HOOKS_ARGS='--hooks {"port":8080,"readyTimeoutInSeconds":180}'`.

**Verify**
- [ ] script prints `✓ image ready: mayfly-runner (arn:…), version SUCCESSFUL`
- [ ] **Record the image ARN in `app/AWS-LEDGER.md`** (snapshot storage until deleted)

---

## 3. Create + install the GitHub App

```bash
npm ci
npm run setup-app                       # personal account
# npm run setup-app -- --org=nortrix-labs   # or under an org
```

Browser opens → **Create** (manifest pre-seeded with the deployed Function URL + Mayfly's permissions) →
the helper writes App id/webhook secret to SSM and the private key to Secrets Manager → click **Install**
on `mikeng-io/mayfly-demo`.

**Governance:** the stack default is `allowedOwners=['mikeng-io']`, `allowAll=false`. `mikeng-io` is served
by default. If installing under a different owner (e.g. `nortrix-labs`), add it to `allowedOwners` in
`infra/bin/mayfly.ts` and `npm run deploy` again first, or the webhook will reject it.

**Verify**
```bash
aws ssm get-parameter --name /mayfly/appId --region ap-northeast-1 --query 'Parameter.Value' --output text          # != REPLACE_ME
aws ssm get-parameter --name /mayfly/webhookSecret --with-decryption --region ap-northeast-1 --query 'Parameter.Value' --output text  # != REPLACE_ME
aws secretsmanager get-secret-value --secret-id /mayfly/appPrivateKey --region ap-northeast-1 --query 'SecretString' --output text | head -c 32
```
- [ ] all three set (not `REPLACE_ME`)
- [ ] App shows as **Installed** on the repo in GitHub

---

## 4. Live integration test

Trigger the workflow in `mikeng-io/mayfly-demo` (`workflow_dispatch` of the `runs-on: [self-hosted, mayfly]` job).

> **Use a plain-shell job** (e.g. `mayfly-spike.yml`). The default `mayfly-runner` image is the LEAN
> variant — no dockerd — so `docker`/`services:` jobs will fail. Those need the `docker` image target.

Watch the pipeline:
```bash
R=ap-northeast-1
aws logs tail /aws/lambda/$(aws cloudformation describe-stack-resources --stack-name MayflyStack --region $R \
  --query "StackResources[?contains(LogicalResourceId,'WebhookFn')].PhysicalResourceId" --output text) --since 5m --region $R --follow &
aws logs tail /aws/lambda/$(aws cloudformation describe-stack-resources --stack-name MayflyStack --region $R \
  --query "StackResources[?contains(LogicalResourceId,'ControlFn')].PhysicalResourceId" --output text) --since 5m --region $R --follow &
aws lambda-microvms list-microvms --region $R --query 'items[].{id:microvmId,state:state}'
```

**Verify the full lifecycle**
- [ ] Webhook logged a 200 for the `queued` event (no 401)
- [ ] Control logged: claim `proceed` → `runMicrovm` → `waitRunning` → JIT hand-off → `markRunning`
- [ ] `list-microvms` shows one `RUNNING` MicroVM during the job
- [ ] Job reaches **completed/success** in GitHub
- [ ] `completed` webhook → teardown → the MicroVM is gone (`list-microvms` empty)
- [ ] DynamoDB record went provisioning → running → deleted
- [ ] No orphan after the 2-min reconciler sweep; DLQ empty; reclaim alarm not firing

---

## 5. Teardown (always)

```bash
# terminate any stragglers
for id in $(aws lambda-microvms list-microvms --region ap-northeast-1 --query 'items[].microvmId' --output text); do
  aws lambda-microvms terminate-microvm --microvm-identifier "$id" --region ap-northeast-1; done
# delete the image
aws lambda-microvms delete-microvm-image --image-identifier mayfly-runner --region ap-northeast-1
# destroy the stack
cd infra && npm run destroy
# Secrets Manager keeps a deleted secret in a recovery window (up to 30d) — this contradicts
# "≈$0" AND blocks a same-day re-deploy (name collision). Force-delete it:
aws secretsmanager delete-secret --secret-id /mayfly/appPrivateKey \
  --force-delete-without-recovery --region ap-northeast-1 2>/dev/null || true
# confirm clean
aws lambda-microvms list-microvms --region ap-northeast-1 --query 'length(items)'   # -> 0
```
- [ ] no MicroVMs remain, image deleted, `MayflyStack` destroyed
- [ ] `/mayfly/appPrivateKey` force-deleted (else it lingers billable + blocks re-deploy)
- [ ] `app/AWS-LEDGER.md` updated; only the standing `CDKToolkit` remains (~$0)

---

## Failure modes → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| `sts get-caller-identity` ≠ 163703054402 | ambient creds wrong account | source repo `.env`; re-check before deploy |
| image build → `CREATION_FAILED` | `/ready` hook/port | check `/aws/lambda/microvms/mayfly-runner` logs; set `MAYFLY_HOOKS_ARGS`; re-run |
| webhook 401 | SSM `webhookSecret` ≠ App's secret | re-run `setup-app` (rewrites the secret) |
| job never provisions | owner not allow-listed, or labels mismatch | check `allowedOwners`; confirm `runs-on` labels; read control logs + DLQ |
| VM not reaped | teardown/`completed` missed | reconciler reaps within `maxRuntime`+grace; else terminate manually |
| stuck `queued` in GitHub | over per-owner quota (requeue budget spent) | raise `perOwnerConcurrency`; re-deploy |

## Rollback
Any step fails irrecoverably → run **Step 5 teardown**, fix, re-run from Step 1. All state is reconstructable
from code; nothing is created manually.
