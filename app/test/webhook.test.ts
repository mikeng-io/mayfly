import { test, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { handler } from '../src/handlers/webhook';

const SECRET = 'whsec';
const ssm = mockClient(SSMClient);
const sqs = mockClient(SQSClient);

beforeEach(() => {
  Object.assign(process.env, {
    MAYFLY_REGION: 'ap-northeast-1',
    IMAGE_NAME: 'mayfly-runner',
    JOBS_TABLE: 'MayflyJobs',
    ATTESTATIONS_TABLE: 'MayflyAttestations',
    QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/1/mayfly',
    LABELS: 'self-hosted,mayfly',
    ALLOWED_OWNERS: 'mikeng-io',
    WEBHOOK_SECRET_PARAM: '/mayfly/webhookSecret',
    APP_ID_PARAM: '/mayfly/appId',
    APP_KEY_PARAM: '/mayfly/appPrivateKey',
    INSTALLATION_ID: '123',
  });
  ssm.reset();
  sqs.reset();
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
  sqs.on(SendMessageCommand).resolves({ MessageId: 'm1' });
});

const queuedBody = {
  action: 'queued',
  workflow_job: { id: 987, run_id: 555, status: 'queued', labels: ['self-hosted', 'mayfly'] },
  repository: { name: 'mayfly-test', full_name: 'mikeng-io/mayfly-test', owner: { login: 'mikeng-io' } },
  installation: { id: 123 },
};

function event(
  body: object,
  opts: { sign?: boolean; base64?: boolean; badSig?: boolean } = {},
) {
  const json = JSON.stringify(body);
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(json)).digest('hex');
  const headers: Record<string, string> = {};
  if (opts.sign !== false) headers['x-hub-signature-256'] = opts.badSig ? 'sha256=deadbeef' : sig;
  return {
    headers,
    body: opts.base64 ? Buffer.from(json).toString('base64') : json,
    isBase64Encoded: !!opts.base64,
  };
}

test('rejects a bad signature with 401 and no enqueue', async () => {
  const res = await handler(event(queuedBody, { badSig: true }));
  expect(res.statusCode).toBe(401);
  expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
});

test('rejects a missing signature with 401', async () => {
  expect((await handler(event(queuedBody, { sign: false }))).statusCode).toBe(401);
});

test('decodes a base64 body before verifying, then enqueues', async () => {
  const res = await handler(event(queuedBody, { base64: true }));
  expect(res.statusCode).toBe(200);
  expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(1);
});

test('queued + matching labels enqueues a provision message', async () => {
  const res = await handler(event(queuedBody));
  expect(res.statusCode).toBe(200);
  const msg = JSON.parse(sqs.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!);
  expect(msg).toMatchObject({
    type: 'provision',
    jobId: '987',
    runId: 555,
    installationId: 123,
    owner: 'mikeng-io',
    repo: 'mayfly-test',
  });
});

test('a repo outside the allowlist is rejected (no enqueue)', async () => {
  const body = {
    ...queuedBody,
    repository: { name: 'x', full_name: 'stranger/x', owner: { login: 'stranger' } },
  };
  const res = await handler(event(body));
  expect(res.statusCode).toBe(200);
  expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
});

test('queued with non-matching labels is ignored', async () => {
  const body = { ...queuedBody, workflow_job: { ...queuedBody.workflow_job, labels: ['ubuntu-latest'] } };
  const res = await handler(event(body));
  expect(res.statusCode).toBe(200);
  expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
});

test('a non queued/completed action is ignored', async () => {
  const res = await handler(event({ ...queuedBody, action: 'in_progress' }));
  expect(res.statusCode).toBe(200);
  expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
});

test('completed enqueues a teardown message', async () => {
  const res = await handler(event({ ...queuedBody, action: 'completed' }));
  expect(res.statusCode).toBe(200);
  const msg = JSON.parse(sqs.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!);
  expect(msg).toMatchObject({ type: 'teardown', jobId: '987' });
});
