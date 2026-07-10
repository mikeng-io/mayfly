# Installing Mayfly

Mayfly is **self-hosted (bring-your-own-cloud)**: you deploy the control plane into your own
AWS account and point a GitHub App at it. Your CI jobs then run in fresh, single-use MicroVMs in
*your* account — you own the isolation boundary and the bill. (It is not a hosted service; the
comparison is CodeBuild / actions-runner-controller, which also run in your account.)

## Prerequisites

- An AWS account with a MicroVM GA region (default **ap-northeast-1** / Tokyo), CDK-bootstrapped.
- Node 20+, and AWS credentials for that account.
- A GitHub repo (or org) where you can create a GitHub App.

## Three steps

### 1. Deploy the control plane

```bash
cd app/infra
npm ci
npm run deploy          # writes app/cdk-outputs.json (incl. the webhook Function URL)
```

This stands up everything (DynamoDB, SQS+DLQ, three Lambdas, the webhook Function URL, alarms,
the 2-minute reconciler). Nothing runs until a GitHub App points at it.

#### Configure who it serves (tenancy governance)

Mayfly runs jobs in **your** account, so it only serves repos you authorize. Set these on the stack
(`infra/bin/mayfly.ts` props) — sane defaults shown:

| Prop | Env | Default | Meaning |
|---|---|---|---|
| `allowedOwners` | `ALLOWED_OWNERS` | `['mikeng-io']` | org/user logins whose repos are served |
| `allowedRepos` | `ALLOWED_REPOS` | `[]` | exact `owner/repo` entries served |
| `allowAll` | `ALLOW_ALL` | `false` | serve every repo the App is installed on (personal setups) |
| `perOwnerConcurrency` | `PER_OWNER_CONCURRENCY` | `10` | max concurrent MicroVMs one owner may hold |
| `maxRequeues` | `MAX_REQUEUES` | `5` | over-quota jobs are delayed-requeued this many times, then dropped |

**Fail-closed:** with no owners/repos and `allowAll=false`, nothing is served — an App installed on an
unexpected repo can't spin up MicroVMs on your bill. A repo outside the allowlist is logged and ignored
(the webhook returns 200 without enqueuing). Over-quota jobs are re-queued with a delay (backpressure),
not dropped, until the requeue budget is exhausted.

### 2. Create the GitHub App — one button

```bash
cd app
npm ci
npm run setup-app                 # personal account
# npm run setup-app -- --org=YOUR_ORG    # or under an org
```

This opens a local page that creates a GitHub App from a **manifest** — pre-seeded with your
deployed Function URL and exactly the permissions Mayfly needs (`Administration: write`,
`Actions: read`, the `workflow_job` event). You click **Create**, and GitHub hands the App's id,
private key, and webhook secret straight back — the helper writes them into your SSM + Secrets
Manager. No permission clicking, no secret copy-paste. Then click **Install** on the repos that
should use Mayfly.

Build the runner image once (Task 12 / `build-image.sh`) so `IMAGE_NAME` resolves.

### 3. Use it

Add the label to any workflow job:

```yaml
jobs:
  build:
    runs-on: [self-hosted, mayfly]
    steps:
      - run: echo "hello from a single-use MicroVM ($(uname -m))"
```

Every matching `queued` job gets its own fresh MicroVM (JIT-registered, one job, terminated on
completion). The reconciler reaps anything the teardown path ever misses.

## Teardown

```bash
cd app/infra && npm run destroy
```

Then delete the runner MicroVM image and confirm no MicroVMs remain
(`aws lambda-microvms list-microvms --region ap-northeast-1`). See `app/AWS-LEDGER.md`.
