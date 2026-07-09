import { test, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  RunMicrovmCommand,
  GetMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} from '@aws-sdk/client-lambda-microvms';
import { createMicrovmClient, networkConnectors } from '../src/lib/microvm';

const lm = mockClient(LambdaMicrovmsClient);
const REGION = 'ap-northeast-1';

function mv(extra: Partial<Parameters<typeof createMicrovmClient>[0]> = {}) {
  return createMicrovmClient({
    region: REGION,
    maxRuntimeSeconds: 3600,
    sleep: async () => {},
    ...extra,
  });
}

beforeEach(() => lm.reset());

test('networkConnectors builds the verified ingress/egress ARNs', () => {
  const nc = networkConnectors(REGION);
  expect(nc.ingress[0]).toBe(
    'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
  );
  expect(nc.egress[0]).toContain(':INTERNET_EGRESS');
});

test('imageArn resolves a name to its ARN', async () => {
  lm.on(ListMicrovmImagesCommand).resolves({
    items: [
      { name: 'other', imageArn: 'arn:x', state: 'CREATED', createdAt: new Date(0) },
      { name: 'mayfly-runner', imageArn: 'arn:runner', state: 'CREATED', createdAt: new Date(0) },
    ],
  });
  expect(await mv().imageArn('mayfly-runner')).toBe('arn:runner');
});

test('imageArn throws when the image is absent', async () => {
  lm.on(ListMicrovmImagesCommand).resolves({ items: [] });
  await expect(mv().imageArn('nope')).rejects.toThrow(/not found/);
});

test('runMicrovm passes the network connectors and NO idlePolicy, returns id+endpoint', async () => {
  lm.on(RunMicrovmCommand).resolves({ microvmId: 'mvm-1', endpoint: 'ep.example', state: 'PENDING' });
  const res = await mv().runMicrovm('arn:runner', 'ct-1');
  expect(res).toEqual({ microvmId: 'mvm-1', endpoint: 'ep.example', state: 'PENDING' });
  const input = lm.commandCalls(RunMicrovmCommand)[0].args[0].input;
  expect(input.imageIdentifier).toBe('arn:runner');
  expect(input.ingressNetworkConnectors![0]).toContain(':ALL_INGRESS');
  expect(input.egressNetworkConnectors![0]).toContain(':INTERNET_EGRESS');
  expect(input.maximumDurationInSeconds).toBe(3600);
  expect(input.idlePolicy).toBeUndefined();
  expect(input.clientToken).toBe('ct-1');
});

test('waitRunning returns once state is RUNNING', async () => {
  lm.on(GetMicrovmCommand).resolvesOnce({ state: 'PENDING' }).resolves({ state: 'RUNNING' });
  await expect(mv().waitRunning('mvm-1', { intervalMs: 0 })).resolves.toBeUndefined();
});

test('waitRunning throws when the VM goes TERMINATED', async () => {
  lm.on(GetMicrovmCommand).resolves({ state: 'TERMINATED', stateReason: 'boom' });
  await expect(mv().waitRunning('mvm-1')).rejects.toThrow(/TERMINATED.*boom/);
});

test('authToken requests all ports for 60min and returns the header map', async () => {
  lm.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: { 'X-aws-proxy-auth': 'tok' } });
  const t = await mv().authToken('mvm-1');
  expect(t).toEqual({ 'X-aws-proxy-auth': 'tok' });
  const input = lm.commandCalls(CreateMicrovmAuthTokenCommand)[0].args[0].input;
  expect(input.expirationInMinutes).toBe(60);
  expect(input.allowedPorts).toEqual([{ allPorts: {} }]);
});

test('postJit POSTs the jitconfig with auth + port-8080 headers', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  await mv({ fetchImpl: fetchImpl as unknown as typeof fetch }).postJit(
    'ep.example',
    { 'X-aws-proxy-auth': 'tok' },
    'ENCODED',
  );
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://ep.example/jit');
  expect(init.headers['X-aws-proxy-auth']).toBe('tok');
  expect(init.headers['X-aws-proxy-port']).toBe('8080');
  expect(JSON.parse(init.body).jitconfig).toBe('ENCODED');
});

test('postJit throws on a non-ok endpoint response', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
  await expect(
    mv({ fetchImpl: fetchImpl as unknown as typeof fetch }).postJit('ep', {}, 'X'),
  ).rejects.toThrow(/postJit failed: 500/);
});

test('terminate swallows a not-found (idempotent)', async () => {
  const err = new Error('gone');
  err.name = 'ResourceNotFoundException';
  lm.on(TerminateMicrovmCommand).rejects(err);
  await expect(mv().terminate('mvm-1')).resolves.toBeUndefined();
});

test('terminate rethrows an unexpected error', async () => {
  lm.on(TerminateMicrovmCommand).rejects(new Error('throttled'));
  await expect(mv().terminate('mvm-1')).rejects.toThrow('throttled');
});
