import { test, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { loadConfig, getSecret } from '../src/lib/config';

const ENV: Record<string, string> = {
  MAYFLY_REGION: 'ap-northeast-1',
  IMAGE_NAME: 'mayfly-runner',
  JOBS_TABLE: 'MayflyJobs',
  QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/1/mayfly',
  REPO_OWNER: 'mikeng-io',
  REPO_NAME: 'mayfly-test',
  LABELS: 'self-hosted, mayfly',
  WEBHOOK_SECRET_PARAM: '/mayfly/webhookSecret',
  APP_ID_PARAM: '/mayfly/appId',
  APP_KEY_PARAM: '/mayfly/appKey',
  INSTALLATION_ID: '12345',
  MAX_RUNTIME_SECONDS: '3600',
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = saved;
});

test('loadConfig maps env and trims/parses labels', () => {
  const c = loadConfig();
  expect(c.region).toBe('ap-northeast-1');
  expect(c.repo).toEqual({ owner: 'mikeng-io', name: 'mayfly-test' });
  expect(c.labels).toEqual(['self-hosted', 'mayfly']);
  expect(c.installationId).toBe(12345);
  expect(c.maxRuntimeSeconds).toBe(3600);
  expect(c.jobsStateIndex).toBe('state-index');
});

test('loadConfig applies defaults for maxConcurrent and provisionTtl', () => {
  const c = loadConfig();
  expect(c.maxConcurrent).toBe(5);
  expect(c.provisionTtlSeconds).toBe(120);
});

test('loadConfig throws naming the missing required var', () => {
  delete process.env.QUEUE_URL;
  expect(() => loadConfig()).toThrow(/QUEUE_URL/);
});

test('getSecret reads a decrypted SSM parameter', async () => {
  const ssm = mockClient(SSMClient);
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'sup3rsecret' } });
  const v = await getSecret('/mayfly/webhookSecret');
  expect(v).toBe('sup3rsecret');
  const input = ssm.commandCalls(GetParameterCommand)[0].args[0].input;
  expect(input.Name).toBe('/mayfly/webhookSecret');
  expect(input.WithDecryption).toBe(true);
});
