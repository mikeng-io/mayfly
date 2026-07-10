import { test, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  buildManifest,
  exchangeManifestCode,
  persistCredentials,
  newAppUrl,
  installUrl,
  type AppCredentials,
} from '../src/lib/manifest';

test('buildManifest requests exactly the Mayfly permissions + workflow_job event', () => {
  const m = buildManifest({ functionUrl: 'https://fn.example/', redirectUrl: 'http://localhost:8722/callback' });
  expect(m.default_permissions).toEqual({ administration: 'write', actions: 'read', metadata: 'read' });
  expect(m.default_events).toEqual(['workflow_job']);
  expect(m.hook_attributes).toEqual({ url: 'https://fn.example/', active: true });
  expect(m.redirect_url).toBe('http://localhost:8722/callback');
  expect(m.public).toBe(false);
});

test('exchangeManifestCode POSTs the conversion and maps the credentials', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      id: 42,
      slug: 'mayfly-runners',
      pem: '-----BEGIN RSA-----',
      webhook_secret: 'whsec',
      html_url: 'https://github.com/apps/mayfly-runners',
    }),
  });
  const creds = await exchangeManifestCode('code123', fetchImpl as unknown as typeof fetch);
  expect(creds).toMatchObject({ appId: 42, slug: 'mayfly-runners', pem: '-----BEGIN RSA-----', webhookSecret: 'whsec' });
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.github.com/app-manifests/code123/conversions');
  expect(init.method).toBe('POST');
});

test('exchangeManifestCode throws on a non-ok response', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
  await expect(exchangeManifestCode('bad', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/422/);
});

const ssm = mockClient(SSMClient);
const secrets = mockClient(SecretsManagerClient);
beforeEach(() => {
  ssm.reset();
  secrets.reset();
  ssm.on(PutParameterCommand).resolves({});
  secrets.on(PutSecretValueCommand).resolves({});
});

test('persistCredentials writes appId + webhook secret to SSM (overwrite) and the key to Secrets Manager', async () => {
  const creds: AppCredentials = {
    appId: 42,
    slug: 's',
    pem: 'PEMKEY',
    webhookSecret: 'whsec',
    htmlUrl: 'x',
  };
  await persistCredentials(creds, {
    region: 'ap-northeast-1',
    webhookSecretParam: '/mayfly/webhookSecret',
    appIdParam: '/mayfly/appId',
    appKeySecretId: '/mayfly/appPrivateKey',
  });
  const puts = ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
  expect(puts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ Name: '/mayfly/appId', Value: '42', Overwrite: true }),
      expect.objectContaining({ Name: '/mayfly/webhookSecret', Value: 'whsec', Overwrite: true }),
    ]),
  );
  const secret = secrets.commandCalls(PutSecretValueCommand)[0].args[0].input;
  expect(secret).toMatchObject({ SecretId: '/mayfly/appPrivateKey', SecretString: 'PEMKEY' });
});

test('newAppUrl targets personal vs org, and installUrl points at the App slug', () => {
  expect(newAppUrl('st')).toBe('https://github.com/settings/apps/new?state=st');
  expect(newAppUrl('st', 'nortrix-labs')).toBe(
    'https://github.com/organizations/nortrix-labs/settings/apps/new?state=st',
  );
  expect(installUrl('mayfly-runners')).toBe('https://github.com/apps/mayfly-runners/installations/new');
});
