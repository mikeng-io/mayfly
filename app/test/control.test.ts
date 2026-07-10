import { test, expect, vi } from 'vitest';
import { processMessage, type ControlDeps, type GithubApi } from '../src/handlers/control';
import type { JobsRepo } from '../src/lib/jobs';
import type { MicrovmClient } from '../src/lib/microvm';
import type { ControlMessage } from '../src/lib/types';

function jobs(over: Partial<JobsRepo> = {}): JobsRepo {
  return {
    beginProvisioning: vi.fn().mockResolvedValue('proceed'),
    attachMicrovm: vi.fn().mockResolvedValue(undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    listByState: vi.fn().mockResolvedValue([]),
    countActiveByOwner: vi.fn().mockResolvedValue(0),
    setFirstSeenOverdue: vi.fn().mockResolvedValue(0),
    ...over,
  } as unknown as JobsRepo;
}

function microvm(over: Partial<MicrovmClient> = {}): MicrovmClient {
  return {
    imageArn: vi.fn().mockResolvedValue('arn:runner'),
    runMicrovm: vi.fn().mockResolvedValue({ microvmId: 'mvm-1', endpoint: 'ep' }),
    waitRunning: vi.fn().mockResolvedValue(undefined),
    getMicrovm: vi.fn().mockResolvedValue({ state: 'RUNNING' }),
    authToken: vi.fn().mockResolvedValue({ 'X-aws-proxy-auth': 'tok' }),
    postJit: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as MicrovmClient;
}

function github(over: Partial<GithubApi> = {}): GithubApi {
  return {
    appJwt: vi.fn().mockReturnValue('jwt'),
    installationToken: vi.fn().mockResolvedValue('tok'),
    generateJitConfig: vi.fn().mockResolvedValue('JIT'),
    getRun: vi.fn().mockResolvedValue({ event: 'push', status: 'queued', headRepoId: 1, baseRepoId: 1 }),
    isForkPR: vi.fn((r) => r.event === 'pull_request' && r.headRepoId !== r.baseRepoId),
    ...over,
  } as unknown as GithubApi;
}

function deps(over: Partial<ControlDeps> = {}): ControlDeps {
  return {
    jobs: jobs(),
    microvm: microvm(),
    github: github(),
    loadAppCreds: vi.fn().mockResolvedValue({ appId: '1', privateKey: 'pem' }),
    imageName: 'mayfly-runner',
    perOwnerConcurrency: 10,
    maxRequeues: 5,
    requeue: vi.fn().mockResolvedValue(undefined),
    sleep: async () => {},
    ...over,
  };
}

const provisionMsg: ControlMessage = {
  type: 'provision',
  jobId: '987',
  runId: 555,
  installationId: 123,
  owner: 'mikeng-io',
  repo: 'mayfly-test',
  labels: ['self-hosted', 'mayfly'],
};

test('provision happy path: records microvm right after run, hands off JIT, marks running as internal', async () => {
  const d = deps();
  await processMessage(provisionMsg, d);
  expect(d.microvm.runMicrovm).toHaveBeenCalledOnce();
  expect(d.jobs.attachMicrovm).toHaveBeenCalledWith('987', 'mvm-1', 'ep');
  // attachMicrovm must fire immediately AFTER runMicrovm (before wait/jit).
  const runOrder = (d.microvm.runMicrovm as any).mock.invocationCallOrder[0];
  const attachOrder = (d.jobs.attachMicrovm as any).mock.invocationCallOrder[0];
  expect(attachOrder).toBeGreaterThan(runOrder);
  expect(d.microvm.postJit).toHaveBeenCalledOnce();
  expect(d.jobs.markRunning).toHaveBeenCalledWith('987', 'mayfly-987', 'internal');
  expect(d.microvm.terminate).not.toHaveBeenCalled();
});

test('beginProvisioning=skip short-circuits (SQS redelivery dedupe)', async () => {
  const d = deps({ jobs: jobs({ beginProvisioning: vi.fn().mockResolvedValue('skip') }) });
  await processMessage(provisionMsg, d);
  expect(d.microvm.runMicrovm).not.toHaveBeenCalled();
});

test('run no longer queued -> delete record, never launch', async () => {
  const d = deps({
    github: github({ getRun: vi.fn().mockResolvedValue({ event: 'push', status: 'completed', headRepoId: 1, baseRepoId: 1 }) }),
  });
  await processMessage(provisionMsg, d);
  expect(d.jobs.deleteJob).toHaveBeenCalledWith('987');
  expect(d.microvm.runMicrovm).not.toHaveBeenCalled();
});

test('waitRunning failure terminates the VM (no leak) and rethrows', async () => {
  const d = deps({
    microvm: microvm({ waitRunning: vi.fn().mockRejectedValue(new Error('TERMINATED: boom')) }),
  });
  await expect(processMessage(provisionMsg, d)).rejects.toThrow('TERMINATED');
  expect(d.microvm.terminate).toHaveBeenCalledWith('mvm-1');
});

test('postJit failure terminates the VM and rethrows', async () => {
  const d = deps({ microvm: microvm({ postJit: vi.fn().mockRejectedValue(new Error('postJit failed: 500')) }) });
  await expect(processMessage(provisionMsg, d)).rejects.toThrow('postJit');
  expect(d.microvm.terminate).toHaveBeenCalledWith('mvm-1');
});

test('fork PR is recorded as trust=fork', async () => {
  const d = deps({
    github: github({ getRun: vi.fn().mockResolvedValue({ event: 'pull_request', status: 'queued', headRepoId: 2, baseRepoId: 1 }) }),
  });
  await processMessage(provisionMsg, d);
  expect(d.jobs.markRunning).toHaveBeenCalledWith('987', 'mayfly-987', 'fork');
});

test('getRun failure is fail-closed: proceeds as fork, does not delete', async () => {
  const d = deps({ github: github({ getRun: vi.fn().mockRejectedValue(new Error('502')) }) });
  await processMessage(provisionMsg, d);
  expect(d.jobs.deleteJob).not.toHaveBeenCalled();
  expect(d.microvm.runMicrovm).toHaveBeenCalledOnce();
  expect(d.jobs.markRunning).toHaveBeenCalledWith('987', 'mayfly-987', 'fork');
});

test('RunMicrovm throttling is retried, then succeeds', async () => {
  const throttled = new Error('rate');
  throttled.name = 'ThrottlingException';
  const runMicrovm = vi
    .fn()
    .mockRejectedValueOnce(throttled)
    .mockResolvedValue({ microvmId: 'mvm-1', endpoint: 'ep' });
  const d = deps({ microvm: microvm({ runMicrovm }) });
  await processMessage(provisionMsg, d);
  expect(runMicrovm).toHaveBeenCalledTimes(2);
  expect(d.jobs.attachMicrovm).toHaveBeenCalledWith('987', 'mvm-1', 'ep');
});

test('over per-owner quota: requeue with attempts++ instead of launching', async () => {
  const d = deps({
    jobs: jobs({ countActiveByOwner: vi.fn().mockResolvedValue(10) }),
    perOwnerConcurrency: 10,
  });
  await processMessage(provisionMsg, d);
  expect(d.requeue).toHaveBeenCalledOnce();
  const [msg] = (d.requeue as any).mock.calls[0];
  expect(msg.attempts).toBe(1);
  expect(d.jobs.beginProvisioning).not.toHaveBeenCalled();
  expect(d.microvm.runMicrovm).not.toHaveBeenCalled();
});

test('quota requeues are bounded: dropped after maxRequeues (no requeue, no launch)', async () => {
  const d = deps({
    jobs: jobs({ countActiveByOwner: vi.fn().mockResolvedValue(10) }),
    perOwnerConcurrency: 10,
    maxRequeues: 5,
  });
  await processMessage({ ...provisionMsg, attempts: 5 }, d);
  expect(d.requeue).not.toHaveBeenCalled();
  expect(d.jobs.beginProvisioning).not.toHaveBeenCalled();
});

test('under quota: provisions normally', async () => {
  const d = deps({ jobs: jobs({ countActiveByOwner: vi.fn().mockResolvedValue(3) }) });
  await processMessage(provisionMsg, d);
  expect(d.requeue).not.toHaveBeenCalled();
  expect(d.microvm.runMicrovm).toHaveBeenCalledOnce();
});

test('teardown terminates the recorded VM and deletes the record', async () => {
  const d = deps({ jobs: jobs({ getJob: vi.fn().mockResolvedValue({ jobId: '987', microvmId: 'mvm-9' }) }) });
  await processMessage(
    { type: 'teardown', jobId: '987', installationId: 123, owner: 'mikeng-io', repo: 'mayfly-test' },
    d,
  );
  expect(d.microvm.terminate).toHaveBeenCalledWith('mvm-9');
  expect(d.jobs.deleteJob).toHaveBeenCalledWith('987');
});
