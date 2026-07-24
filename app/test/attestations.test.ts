import { test, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createAttestationsRepo } from '../src/lib/attestations';

const ddb = mockClient(DynamoDBDocumentClient);
const TABLE = 'Attestations';
const NOW = 1_700_000_000;
const TTL = 30 * 24 * 60 * 60;

function repo() {
  return createAttestationsRepo({ table: TABLE, ttlSeconds: TTL, now: () => NOW });
}

beforeEach(() => ddb.reset());

test('record stores the pairing with launchedAt and a long TTL', async () => {
  ddb.on(PutCommand).resolves({});
  await repo().record({
    microvmId: 'mvm-1',
    jobId: '987',
    runnerName: 'mayfly-987',
    endpoint: 'ep',
    trust: 'internal',
  });
  const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
  expect(item.microvmId).toBe('mvm-1');
  expect(item.runnerName).toBe('mayfly-987');
  expect(item.launchedAt).toBe(NOW);
  expect(item.expiresAt).toBe(NOW + TTL);
  expect(item.terminatedAt).toBeUndefined();
});

test('evidence outlives operational state: TTL is far longer than the jobs table 24h', async () => {
  ddb.on(PutCommand).resolves({});
  await repo().record({ microvmId: 'mvm-1', jobId: '9', runnerName: 'r', trust: 'fork' });
  const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
  expect(item.expiresAt - item.launchedAt).toBeGreaterThan(24 * 60 * 60);
});

test('markTerminated updates rather than deletes, so the pairing survives', async () => {
  ddb.on(UpdateCommand).resolves({});
  await repo().markTerminated('mvm-1');
  const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(input.Key).toEqual({ microvmId: 'mvm-1' });
  expect(input.UpdateExpression).toContain('terminatedAt');
  expect(input.ConditionExpression).toContain('attribute_exists');
});

test('markTerminated on an unattested VM is a no-op, not a half-written record', async () => {
  const err = new Error('nope');
  err.name = 'ConditionalCheckFailedException';
  ddb.on(UpdateCommand).rejects(err);
  await expect(repo().markTerminated('mvm-unknown')).resolves.toBeUndefined();
});

test('markTerminated surfaces real failures', async () => {
  ddb.on(UpdateCommand).rejects(new Error('throttled'));
  await expect(repo().markTerminated('mvm-1')).rejects.toThrow('throttled');
});

test('get returns the record for cross-checking a receipt', async () => {
  ddb.on(GetCommand).resolves({
    Item: { microvmId: 'mvm-1', jobId: '987', runnerName: 'mayfly-987', trust: 'internal' },
  });
  const rec = await repo().get('mvm-1');
  expect(rec?.runnerName).toBe('mayfly-987');
});

test('record is write-once: it cannot overwrite an existing attestation', async () => {
  ddb.on(PutCommand).resolves({});
  await repo().record({ microvmId: 'mvm-1', jobId: '1', runnerName: 'mayfly-1', trust: 'internal' });
  // Without this condition a re-drive would reset launchedAt and erase terminatedAt,
  // silently rewriting the evidence it exists to preserve.
  expect(ddb.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe(
    'attribute_not_exists(microvmId)',
  );
});

test('re-attesting the same VM is tolerated (redelivery) but does not throw', async () => {
  const err = new Error('exists');
  err.name = 'ConditionalCheckFailedException';
  ddb.on(PutCommand).rejects(err);
  await expect(
    repo().record({ microvmId: 'mvm-1', jobId: '1', runnerName: 'mayfly-1', trust: 'internal' }),
  ).resolves.toBeUndefined();
});

test('record surfaces real write failures so the provision aborts', async () => {
  ddb.on(PutCommand).rejects(new Error('throttled'));
  await expect(
    repo().record({ microvmId: 'mvm-1', jobId: '1', runnerName: 'mayfly-1', trust: 'internal' }),
  ).rejects.toThrow('throttled');
});

test('the first termination stamp is authoritative', async () => {
  ddb.on(UpdateCommand).resolves({});
  await repo().markTerminated('mvm-1');
  expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toContain(
    'attribute_not_exists(terminatedAt)',
  );
});

test('a repo built without a table name fails loudly at construction', () => {
  expect(() => createAttestationsRepo({ table: '', ttlSeconds: TTL })).toThrow(/ATTESTATIONS_TABLE/);
});
