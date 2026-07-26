import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  appJwt,
  decodeJwtClaims,
  isForkPR,
  installationToken,
  generateJitConfig,
  getRun,
  listInstallations,
  listQueuedJobs,
} from '../src/lib/github';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// --- pure logic ---
test('isForkPR true when head repo differs', () =>
  expect(isForkPR({ event: 'pull_request', headRepoId: 2, baseRepoId: 1, status: 'queued' })).toBe(
    true,
  ));
test('isForkPR false for internal push', () =>
  expect(isForkPR({ event: 'push', headRepoId: 1, baseRepoId: 1, status: 'queued' })).toBe(false));
test('isForkPR false for a same-repo PR (branch, not fork)', () =>
  expect(isForkPR({ event: 'pull_request', headRepoId: 1, baseRepoId: 1, status: 'queued' })).toBe(
    false,
  ));

test('appJwt sets iss and a -60s / +540s window', () => {
  const now = 1_000_000;
  const claims = decodeJwtClaims(appJwt('12345', pem, now));
  expect(claims.iss).toBe('12345');
  expect(claims.iat).toBe(now - 60);
  expect(claims.exp).toBe(now + 540);
});

test('appJwt signature verifies with the public key (RS256)', () => {
  const [h, p, s] = appJwt('12345', pem, 1_000_000).split('.');
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(pubPem, Buffer.from(s, 'base64url'));
  expect(ok).toBe(true);
});

// --- fetch command shapes ---
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

test('installationToken posts with the app JWT and returns the token', async () => {
  (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ token: 'ghs_x' }) });
  const t = await installationToken('jwt123', 42);
  expect(t).toBe('ghs_x');
  const [url, init] = (fetch as any).mock.calls[0];
  expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer jwt123');
});

test('generateJitConfig targets the repo and returns encoded_jit_config', async () => {
  (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ encoded_jit_config: 'BLOB' }) });
  const blob = await generateJitConfig('tok', 'mikeng-io', 'mayfly-test', 'job-1', [
    'self-hosted',
    'mayfly',
  ]);
  expect(blob).toBe('BLOB');
  const [url, init] = (fetch as any).mock.calls[0];
  expect(url).toContain('/repos/mikeng-io/mayfly-test/actions/runners/generate-jitconfig');
  const sent = JSON.parse(init.body);
  expect(sent.name).toBe('job-1');
  expect(sent.labels).toEqual(['self-hosted', 'mayfly']);
});

test('getRun maps event/status/head/base repo ids', async () => {
  (fetch as any).mockResolvedValue({
    ok: true,
    json: async () => ({
      event: 'pull_request',
      status: 'queued',
      repository: { id: 1 },
      head_repository: { id: 2 },
    }),
  });
  const run = await getRun('tok', 'o', 'r', 99);
  expect(run).toEqual({ event: 'pull_request', status: 'queued', baseRepoId: 1, headRepoId: 2 });
  expect(isForkPR(run)).toBe(true);
});

test('installationToken throws on a non-ok response', async () => {
  (fetch as any).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
  await expect(installationToken('jwt', 1)).rejects.toThrow();
});

test('listInstallations maps id + account login', async () => {
  (fetch as any).mockResolvedValue({
    ok: true,
    json: async () => [{ id: 7, account: { login: 'mikeng-io' } }, { id: 9 }],
  });
  const out = await listInstallations('jwt123');
  expect(out).toEqual([
    { id: 7, login: 'mikeng-io' },
    { id: 9, login: '' },
  ]);
  const [url, init] = (fetch as any).mock.calls[0];
  expect(url).toBe('https://api.github.com/app/installations?per_page=100');
  expect(init.headers.Authorization).toBe('Bearer jwt123');
});

test('listQueuedJobs collects queued jobs across queued AND in_progress runs', async () => {
  (fetch as any).mockImplementation(async (url: string) => {
    if (url.includes('status=queued'))
      return { ok: true, json: async () => ({ workflow_runs: [{ id: 100 }] }) };
    if (url.includes('status=in_progress'))
      return { ok: true, json: async () => ({ workflow_runs: [{ id: 200 }] }) };
    if (url.includes('/runs/100/jobs'))
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { id: 1, run_id: 100, status: 'queued', labels: ['mayfly'], created_at: '2026-07-26T07:32:29Z' },
          ],
        }),
      };
    if (url.includes('/runs/200/jobs'))
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { id: 2, run_id: 200, status: 'in_progress', labels: ['mayfly'], created_at: '2026-07-26T07:33:04Z' },
            { id: 3, run_id: 200, status: 'queued', labels: ['mayfly'], created_at: '2026-07-26T07:33:04Z' },
          ],
        }),
      };
    throw new Error(`unexpected url ${url}`);
  });
  const out = await listQueuedJobs('tok', 'mikeng-io', 'mayfly-demo');
  expect(out).toEqual([
    { jobId: '1', runId: 100, labels: ['mayfly'], queuedAt: Math.floor(Date.parse('2026-07-26T07:32:29Z') / 1000) },
    { jobId: '3', runId: 200, labels: ['mayfly'], queuedAt: Math.floor(Date.parse('2026-07-26T07:33:04Z') / 1000) },
  ]);
});

test('listQueuedJobs surfaces a non-ok jobs response as an error', async () => {
  (fetch as any).mockImplementation(async (url: string) => {
    if (url.includes('status=queued'))
      return { ok: true, json: async () => ({ workflow_runs: [{ id: 100 }] }) };
    if (url.includes('status=in_progress'))
      return { ok: true, json: async () => ({ workflow_runs: [] }) };
    return { ok: false, status: 500 };
  });
  await expect(listQueuedJobs('tok', 'o', 'r')).rejects.toThrow('listJobs(100) failed: 500');
});
