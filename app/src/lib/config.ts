import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface Config {
  region: string;
  imageName: string;
  jobsTable: string;
  jobsStateIndex: string;
  /** Durable (microvmId -> runnerName) evidence table. */
  attestationsTable: string;
  queueUrl: string;
  labels: string[];
  webhookSecretParam: string;
  appIdParam: string;
  appKeyParam: string;
  /** Optional fallback; handlers normally take installationId from the webhook event/message. */
  installationId?: number;
  maxRuntimeSeconds: number;
  maxConcurrent: number;
  provisionTtlSeconds: number;
  // --- tenancy governance ---
  allowedOwners: string[];
  allowedRepos: string[];
  allowAll: boolean;
  /** Max concurrent (provisioning+running) MicroVMs a single owner may hold. */
  perOwnerConcurrency: number;
  /** How many times an over-quota provision is re-queued before it is dropped. */
  maxRequeues: number;
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Load config from env vars set by the CDK stack. Secret *values* are resolved lazily via getSecret. */
export function loadConfig(): Config {
  return {
    region: req('MAYFLY_REGION'),
    imageName: req('IMAGE_NAME'),
    jobsTable: req('JOBS_TABLE'),
    jobsStateIndex: process.env.JOBS_STATE_INDEX ?? 'state-index',
    // NOT req(): this lands in commonEnv, so req() would make it mandatory for the webhook
    // Lambda, which never reads it. A code-only deploy (--hotswap, update-function-code, a
    // template rollback) that missed the var would then 5xx every GitHub delivery and stop
    // all ingress, over a value that handler doesn't use. The repos that need it fail at
    // construction instead, where the error names the real cause.
    attestationsTable: process.env.ATTESTATIONS_TABLE ?? '',
    queueUrl: req('QUEUE_URL'),
    labels: csv('LABELS'),
    webhookSecretParam: req('WEBHOOK_SECRET_PARAM'),
    appIdParam: req('APP_ID_PARAM'),
    appKeyParam: req('APP_KEY_PARAM'),
    installationId: process.env.INSTALLATION_ID ? Number(process.env.INSTALLATION_ID) : undefined,
    maxRuntimeSeconds: Number(process.env.MAX_RUNTIME_SECONDS ?? '3600'),
    maxConcurrent: Number(process.env.MAX_CONCURRENT ?? '5'),
    provisionTtlSeconds: Number(process.env.PROVISION_TTL_SECONDS ?? '120'),
    allowedOwners: csv('ALLOWED_OWNERS'),
    allowedRepos: csv('ALLOWED_REPOS'),
    allowAll: process.env.ALLOW_ALL === 'true',
    perOwnerConcurrency: Number(process.env.PER_OWNER_CONCURRENCY ?? '10'),
    maxRequeues: Number(process.env.MAX_REQUEUES ?? '5'),
  };
}

let ssm: SSMClient | undefined;

/** Resolve a (possibly SecureString) SSM parameter, decrypted. */
export async function getSecret(param: string, region?: string): Promise<string> {
  ssm ??= new SSMClient({ region: region ?? process.env.MAYFLY_REGION });
  const res = await ssm.send(new GetParameterCommand({ Name: param, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter empty or missing: ${param}`);
  return value;
}

let secretsManager: SecretsManagerClient | undefined;

/** Resolve a Secrets Manager secret value (e.g. the GitHub App private key). */
export async function getSecretsManagerValue(nameOrArn: string, region?: string): Promise<string> {
  secretsManager ??= new SecretsManagerClient({ region: region ?? process.env.MAYFLY_REGION });
  const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: nameOrArn }));
  const value = res.SecretString;
  if (!value) throw new Error(`Secrets Manager secret empty or missing: ${nameOrArn}`);
  return value;
}
