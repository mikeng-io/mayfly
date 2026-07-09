import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

export interface Config {
  region: string;
  imageName: string;
  jobsTable: string;
  jobsStateIndex: string;
  queueUrl: string;
  repo: { owner: string; name: string };
  labels: string[];
  webhookSecretParam: string;
  appIdParam: string;
  appKeyParam: string;
  /** Optional fallback; handlers normally take installationId from the webhook event/message. */
  installationId?: number;
  maxRuntimeSeconds: number;
  maxConcurrent: number;
  provisionTtlSeconds: number;
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
    queueUrl: req('QUEUE_URL'),
    repo: { owner: req('REPO_OWNER'), name: req('REPO_NAME') },
    labels: req('LABELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webhookSecretParam: req('WEBHOOK_SECRET_PARAM'),
    appIdParam: req('APP_ID_PARAM'),
    appKeyParam: req('APP_KEY_PARAM'),
    installationId: process.env.INSTALLATION_ID ? Number(process.env.INSTALLATION_ID) : undefined,
    maxRuntimeSeconds: Number(process.env.MAX_RUNTIME_SECONDS ?? '3600'),
    maxConcurrent: Number(process.env.MAX_CONCURRENT ?? '5'),
    provisionTtlSeconds: Number(process.env.PROVISION_TTL_SECONDS ?? '120'),
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
