import { createSign } from 'node:crypto';

const GH = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** The run fields we need for the queued re-check and fork detection. */
export interface RunInfo {
  event: string;
  status: string;
  headRepoId?: number;
  baseRepoId?: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function ghHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

/**
 * Mint a short-lived (10-min) RS256 App JWT. `now` is injectable for testing;
 * iat is backdated 60s to tolerate clock skew, exp is +9min (< GitHub's 10-min cap).
 */
export function appJwt(
  appId: string | number,
  privateKeyPem: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: String(appId), iat: now - 60, exp: now + 540 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode a JWT's payload claims (no signature verification — for inspection/tests). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Fork PRs run head code from a different repo than the base. */
export function isForkPR(run: RunInfo): boolean {
  return run.event === 'pull_request' && run.headRepoId !== run.baseRepoId;
}

/** Exchange an App JWT for a 1-hour installation token. */
export async function installationToken(jwt: string, installationId: number): Promise<string> {
  const res = await fetch(`${GH}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(jwt),
  });
  if (!res.ok) throw new Error(`installationToken failed: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Generate a single-use JIT runner config; returns the opaque `encoded_jit_config` blob. */
export async function generateJitConfig(
  token: string,
  owner: string,
  repo: string,
  name: string,
  labels: string[],
): Promise<string> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/runners/generate-jitconfig`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ name, runner_group_id: 1, labels, work_folder: '_work' }),
  });
  if (!res.ok) throw new Error(`generateJitConfig failed: ${res.status}`);
  const body = (await res.json()) as { encoded_jit_config: string };
  return body.encoded_jit_config;
}

/** Fetch a workflow run for the queued re-check + fork detection. */
export async function getRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<RunInfo> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/runs/${runId}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error(`getRun failed: ${res.status}`);
  const body = (await res.json()) as {
    event: string;
    status: string;
    repository?: { id: number };
    head_repository?: { id: number };
  };
  return {
    event: body.event,
    status: body.status,
    baseRepoId: body.repository?.id,
    headRepoId: body.head_repository?.id,
  };
}
