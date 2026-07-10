import { test, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createJobsRepo } from '../src/lib/jobs';

const ddb = mockClient(DynamoDBDocumentClient);

const NOW = 1_000_000;
function repo() {
  return createJobsRepo({
    table: 'MayflyJobs',
    stateIndex: 'state-index',
    provisionTtlSeconds: 120,
    recordTtlSeconds: 86_400,
    now: () => NOW,
  });
}

beforeEach(() => ddb.reset());

test('beginProvisioning returns "proceed" and writes a provisioning record with a stale-guard condition', async () => {
  ddb.on(PutCommand).resolves({});
  const r = await repo().beginProvisioning('job-1', 55, 'acme');
  expect(r).toBe('proceed');
  const input = ddb.commandCalls(PutCommand)[0].args[0].input;
  expect(input.TableName).toBe('MayflyJobs');
  expect(input.Item).toMatchObject({ jobId: 'job-1', runId: 55, owner: 'acme', state: 'provisioning', createdAt: NOW });
  expect(input.ConditionExpression).toContain('attribute_not_exists(jobId)');
  expect(input.ExpressionAttributeValues![':stale']).toBe(NOW - 120);
});

test('beginProvisioning returns "skip" when the conditional claim fails (fresh/running record exists)', async () => {
  const err = new Error('exists');
  err.name = 'ConditionalCheckFailedException';
  ddb.on(PutCommand).rejects(err);
  const r = await repo().beginProvisioning('job-1', 55);
  expect(r).toBe('skip');
});

test('beginProvisioning rethrows a non-conditional error', async () => {
  ddb.on(PutCommand).rejects(new Error('throttled'));
  await expect(repo().beginProvisioning('job-1', 55)).rejects.toThrow('throttled');
});

test('attachMicrovm updates the record with microvmId + endpoint', async () => {
  ddb.on(UpdateCommand).resolves({});
  await repo().attachMicrovm('job-1', 'microvm-abc', 'ep.example');
  const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(input.Key).toEqual({ jobId: 'job-1' });
  expect(input.ExpressionAttributeValues![':m']).toBe('microvm-abc');
  expect(input.ExpressionAttributeValues![':e']).toBe('ep.example');
});

test('markRunning sets state=running', async () => {
  ddb.on(UpdateCommand).resolves({});
  await repo().markRunning('job-1', 'runner-x');
  const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(input.ExpressionAttributeValues![':r']).toBe('running');
  expect(input.ExpressionAttributeValues![':n']).toBe('runner-x');
});

test('getJob maps the item', async () => {
  ddb.on(GetCommand).resolves({ Item: { jobId: 'job-1', state: 'running', microvmId: 'm1' } });
  const rec = await repo().getJob('job-1');
  expect(rec?.microvmId).toBe('m1');
});

test('deleteJob deletes by key', async () => {
  ddb.on(DeleteCommand).resolves({});
  await repo().deleteJob('job-1');
  expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ jobId: 'job-1' });
});

test('listByState queries the GSI by state', async () => {
  ddb.on(QueryCommand).resolves({ Items: [{ jobId: 'a', state: 'running' }] });
  const items = await repo().listByState('running');
  expect(items).toHaveLength(1);
  const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
  expect(input.IndexName).toBe('state-index');
  expect(input.ExpressionAttributeValues![':s']).toBe('running');
});

test('countActiveByOwner sums provisioning+running records for one owner', async () => {
  ddb
    .on(QueryCommand, { ExpressionAttributeValues: { ':s': 'provisioning' } })
    .resolves({ Items: [{ jobId: 'a', owner: 'acme' }] })
    .on(QueryCommand, { ExpressionAttributeValues: { ':s': 'running' } })
    .resolves({ Items: [{ jobId: 'b', owner: 'acme' }, { jobId: 'c', owner: 'other' }] });
  expect(await repo().countActiveByOwner('acme')).toBe(2);
});

test('setFirstSeenOverdue is idempotent (if_not_exists) and returns the marker', async () => {
  ddb.on(UpdateCommand).resolves({ Attributes: { jobId: 'job-1', firstSeenOverdue: NOW } });
  const t = await repo().setFirstSeenOverdue('job-1');
  expect(t).toBe(NOW);
  const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(input.UpdateExpression).toContain('if_not_exists(firstSeenOverdue');
});
