import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * GitHub App Manifest flow — the low-friction install path. The adopter clicks one
 * button; GitHub creates the App pre-configured with exactly the permissions/events
 * Mayfly needs and redirects back with a temporary `code`, which we exchange for the
 * App id, private key, and webhook secret, then write straight into AWS.
 * Docs: https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

export interface ManifestOptions {
  functionUrl: string; // webhook target (the deployed Function URL)
  redirectUrl: string; // local callback the setup server listens on
  name?: string;
  homepageUrl?: string;
}

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/** The exact permissions + event Mayfly requires — the whole point of the manifest. */
export function buildManifest(opts: ManifestOptions): AppManifest {
  return {
    name: opts.name ?? 'Mayfly Runners',
    url: opts.homepageUrl ?? 'https://github.com/mikeng-io/mayfly',
    hook_attributes: { url: opts.functionUrl, active: true },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: {
      administration: 'write', // JIT self-hosted runner registration
      actions: 'read', // getRun: queued re-check + fork detection
      metadata: 'read', // mandatory baseline
    },
    default_events: ['workflow_job'],
  };
}

export interface AppCredentials {
  appId: number;
  slug: string;
  pem: string;
  webhookSecret: string;
  htmlUrl: string;
}

/** Exchange the one-hour, single-use manifest `code` for the created App's credentials. */
export async function exchangeManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppCredentials> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`manifest conversion failed: ${res.status}`);
  const b = (await res.json()) as {
    id: number;
    slug: string;
    pem: string;
    webhook_secret: string;
    html_url: string;
  };
  return { appId: b.id, slug: b.slug, pem: b.pem, webhookSecret: b.webhook_secret, htmlUrl: b.html_url };
}

export interface PersistTargets {
  region: string;
  webhookSecretParam: string;
  appIdParam: string;
  appKeySecretId: string;
}

/** Write the App id + webhook secret to SSM and the private key to Secrets Manager. */
export async function persistCredentials(
  creds: AppCredentials,
  targets: PersistTargets,
  clients?: { ssm?: SSMClient; secrets?: SecretsManagerClient },
): Promise<void> {
  const ssm = clients?.ssm ?? new SSMClient({ region: targets.region });
  const secrets = clients?.secrets ?? new SecretsManagerClient({ region: targets.region });
  await ssm.send(
    new PutParameterCommand({
      Name: targets.appIdParam,
      Value: String(creds.appId),
      Type: 'String',
      Overwrite: true,
    }),
  );
  await ssm.send(
    new PutParameterCommand({
      Name: targets.webhookSecretParam,
      Value: creds.webhookSecret,
      Type: 'String',
      Overwrite: true,
    }),
  );
  await secrets.send(
    new PutSecretValueCommand({ SecretId: targets.appKeySecretId, SecretString: creds.pem }),
  );
}

/** GitHub's "create App from manifest" endpoint — personal account or org. */
export function newAppUrl(state: string, org?: string): string {
  const base = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export function installUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
