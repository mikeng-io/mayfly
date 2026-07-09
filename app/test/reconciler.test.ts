import { test, expect, vi } from 'vitest';
import { reconcile, type ReconcilerDeps } from '../src/handlers/reconciler';
import type { JobsRepo } from '../src/lib/jobs';
import type { MicrovmClient } from '../src/lib/microvm';
import type { JobRecord, JobState } from '../src/lib/types';

const NOW = 10_000;
const MAX = 3600;
const GRACE = 120;

function rec(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'j1',
    runId: 1,
    state: 'running',
    microvmId: 'mvm-1',
    createdAt: 0, // => overdue at NOW
    updatedAt: 0,
    expiresAt: NOW + 1000,
    ...over,
  };
}

function jobs(records: JobRecord[], over: Partial<JobsRepo> = {}): JobsRepo {
  return {
    beginProvisioning: vi.fn(),
    attachMicrovm: vi.fn(),
    markRunning: vi.fn(),
    getJob: vi.fn(),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    listByState: vi.fn((s: JobState) => Promise.resolve(s === 'running' ? records : [])),
    setFirstSeenOverdue: vi.fn().mockResolvedValue(NOW),
    ...over,
  } as unknown as JobsRepo;
}

function microvm(state: string | undefined = 'RUNNING', over: Partial<MicrovmClient> = {}): MicrovmClient {
  return {
    imageArn: vi.fn(),
    runMicrovm: vi.fn(),
    waitRunning: vi.fn(),
    getMicrovm: vi.fn().mockResolvedValue({ state }),
    authToken: vi.fn(),
    postJit: vi.fn(),
    terminate: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as MicrovmClient;
}

function deps(over: Partial<ReconcilerDeps>): ReconcilerDeps {
  return {
    jobs: jobs([]),
    microvm: microvm(),
    maxRuntimeSeconds: MAX,
    graceSeconds: GRACE,
    now: () => NOW,
    emitReclaimed: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test('overdue + alive + past grace => terminate, delete, and emit the reclaim metric', async () => {
  const d = deps({ jobs: jobs([rec({ firstSeenOverdue: NOW - GRACE - 1 })]), microvm: microvm('RUNNING') });
  const res = await reconcile(d);
  expect(res.reclaimed).toBe(1);
  expect(d.microvm.terminate).toHaveBeenCalledWith('mvm-1');
  expect(d.jobs.deleteJob).toHaveBeenCalledWith('j1');
  expect(d.emitReclaimed).toHaveBeenCalledWith(1);
});

test('fresh (not overdue) record is left alone', async () => {
  const d = deps({ jobs: jobs([rec({ createdAt: NOW })]), microvm: microvm('RUNNING') });
  const res = await reconcile(d);
  expect(res.reclaimed).toBe(0);
  expect(d.microvm.terminate).not.toHaveBeenCalled();
  expect(d.jobs.deleteJob).not.toHaveBeenCalled();
});

test('overdue but first sighting: mark firstSeenOverdue and wait (no reap this sweep)', async () => {
  const d = deps({ jobs: jobs([rec({ firstSeenOverdue: undefined })]), microvm: microvm('RUNNING') });
  const res = await reconcile(d);
  expect(res.reclaimed).toBe(0);
  expect(d.jobs.setFirstSeenOverdue).toHaveBeenCalledWith('j1');
  expect(d.microvm.terminate).not.toHaveBeenCalled();
});

test('VM already gone => clean the record, but do NOT count it as a reclaim', async () => {
  const d = deps({ jobs: jobs([rec({ firstSeenOverdue: NOW - GRACE - 1 })]), microvm: microvm('TERMINATED') });
  const res = await reconcile(d);
  expect(res.reclaimed).toBe(0);
  expect(d.jobs.deleteJob).toHaveBeenCalledWith('j1');
  expect(d.emitReclaimed).not.toHaveBeenCalled();
});

test('acts only on listByState records — never a region-wide microvm list', async () => {
  const j = jobs([]);
  const d = deps({ jobs: j });
  await reconcile(d);
  expect(j.listByState).toHaveBeenCalledWith('provisioning');
  expect(j.listByState).toHaveBeenCalledWith('running');
  // MicrovmClient exposes no list-all; the reconciler only ever touches recorded ids.
  expect(d.microvm.getMicrovm).not.toHaveBeenCalled();
});
