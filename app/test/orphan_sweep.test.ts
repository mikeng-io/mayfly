import { test, expect, vi } from 'vitest';
import { sweepOrphanedJobs, type OrphanSweepDeps } from '../src/lib/orphan_sweep';
import type { JobsRepo } from '../src/lib/jobs';
import type { JobRecord, ControlMessage } from '../src/lib/types';

const NOW = 100_000;
const ORPHAN_AFTER = 180;
const STALE_RUNNING_AFTER = 120;

function queuedJob(over: Partial<{ jobId: string; runId: number; labels: string[]; queuedAt: number }> = {}) {
  return {
    jobId: 'j-orphan',
    runId: 42,
    labels: ['mayfly'],
    queuedAt: NOW - ORPHAN_AFTER - 60, // past the orphan threshold
    ...over,
  };
}

function rec(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'j-orphan',
    runId: 42,
    state: 'running',
    microvmId: 'mvm-1',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    expiresAt: NOW + 1000,
    ...over,
  };
}

function jobs(over: Partial<JobsRepo> = {}): JobsRepo {
  return {
    beginProvisioning: vi.fn(),
    attachMicrovm: vi.fn(),
    markRunning: vi.fn(),
    getJob: vi.fn().mockResolvedValue(undefined),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    listByState: vi.fn().mockResolvedValue([]),
    countActiveByOwner: vi.fn().mockResolvedValue(0),
    setFirstSeenOverdue: vi.fn().mockResolvedValue(NOW),
    ...over,
  } as unknown as JobsRepo;
}

function deps(over: Partial<OrphanSweepDeps> = {}): OrphanSweepDeps {
  return {
    jobs: jobs(),
    github: {
      appJwt: vi.fn().mockReturnValue('jwt'),
      installationToken: vi.fn().mockResolvedValue('tok'),
      listInstallations: vi.fn().mockResolvedValue([{ id: 7, login: 'mikeng-io' }]),
      listQueuedJobs: vi.fn().mockResolvedValue([queuedJob()]),
    },
    loadAppCreds: vi.fn().mockResolvedValue({ appId: '1', privateKey: 'pem' }),
    allowedRepos: ['mikeng-io/mayfly-demo'],
    labels: ['mayfly'],
    enqueueProvision: vi.fn().mockResolvedValue(undefined),
    orphanAfterSeconds: ORPHAN_AFTER,
    staleRunningAfterSeconds: STALE_RUNNING_AFTER,
    now: () => NOW,
    emitOrphansReprovisioned: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test('re-enqueues a provision for a queued job with no record (consumed webhook)', async () => {
  const d = deps();
  const res = await sweepOrphanedJobs(d);
  expect(res.reprovisioned).toBe(1);
  expect(d.enqueueProvision).toHaveBeenCalledTimes(1);
  const msg = (d.enqueueProvision as ReturnType<typeof vi.fn>).mock.calls[0][0] as ControlMessage;
  expect(msg).toMatchObject({
    type: 'provision',
    jobId: 'j-orphan',
    runId: 42,
    installationId: 7,
    owner: 'mikeng-io',
    repo: 'mayfly-demo',
    labels: ['mayfly'],
  });
  expect(d.emitOrphansReprovisioned).toHaveBeenCalledWith(1);
});

test('the birth case: queued on GitHub but our record says running (stolen VM) -> delete lie + re-enqueue', async () => {
  // 2026-07-26 07:33: job 89769457679's VM was assigned to a different job by
  // GitHub's label-pool scheduler; the record stayed 'running' while the job sat
  // queued 2h38m. GitHub's queued-status past the threshold outranks our record.
  const j = jobs({ getJob: vi.fn().mockResolvedValue(rec({ state: 'running', updatedAt: NOW - STALE_RUNNING_AFTER - 30 })) });
  const d = deps({ jobs: j });
  const res = await sweepOrphanedJobs(d);
  expect(res.reprovisioned).toBe(1);
  expect(j.deleteJob).toHaveBeenCalledWith('j-orphan');
  expect(d.enqueueProvision).toHaveBeenCalledTimes(1);
});

test('does NOT touch a running record younger than the stale threshold (runner may still be registering)', async () => {
  const j = jobs({ getJob: vi.fn().mockResolvedValue(rec({ state: 'running', updatedAt: NOW - 10 })) });
  const d = deps({ jobs: j });
  const res = await sweepOrphanedJobs(d);
  expect(res.reprovisioned).toBe(0);
  expect(j.deleteJob).not.toHaveBeenCalled();
  expect(d.enqueueProvision).not.toHaveBeenCalled();
});

test('skips a job with an in-flight provisioning record', async () => {
  const j = jobs({ getJob: vi.fn().mockResolvedValue(rec({ state: 'provisioning' })) });
  const d = deps({ jobs: j });
  expect((await sweepOrphanedJobs(d)).reprovisioned).toBe(0);
  expect(d.enqueueProvision).not.toHaveBeenCalled();
});

test('skips jobs younger than the orphan threshold (normal pickup latency is not an orphan)', async () => {
  const d = deps();
  (d.github.listQueuedJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
    queuedJob({ queuedAt: NOW - 30 }),
  ]);
  expect((await sweepOrphanedJobs(d)).reprovisioned).toBe(0);
  expect(d.enqueueProvision).not.toHaveBeenCalled();
});

test('skips jobs whose labels do not include all configured labels', async () => {
  const d = deps();
  (d.github.listQueuedJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
    queuedJob({ labels: ['ubuntu-latest'] }),
  ]);
  expect((await sweepOrphanedJobs(d)).reprovisioned).toBe(0);
});

test('no allowedRepos -> sweep is a no-op (allowAll/owner-only deployments are not enumerable)', async () => {
  const d = deps({ allowedRepos: [] });
  expect((await sweepOrphanedJobs(d)).reprovisioned).toBe(0);
  expect(d.loadAppCreds).not.toHaveBeenCalled();
});

test('a GitHub failure on one repo is contained: logged, swept 0, never throws', async () => {
  const d = deps();
  (d.github.listQueuedJobs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gh 500'));
  await expect(sweepOrphanedJobs(d)).resolves.toEqual({ reprovisioned: 0 });
});

test('a repo whose owner has no installation is skipped, others still sweep', async () => {
  const d = deps({ allowedRepos: ['ghost-org/nope', 'mikeng-io/mayfly-demo'] });
  (d.github.listQueuedJobs as ReturnType<typeof vi.fn>).mockResolvedValue([queuedJob()]);
  const res = await sweepOrphanedJobs(d);
  expect(res.reprovisioned).toBe(1);
  expect(d.github.listQueuedJobs).toHaveBeenCalledTimes(1); // ghost-org never queried
});

test('does not emit the metric when nothing was reprovisioned', async () => {
  const d = deps();
  (d.github.listQueuedJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await sweepOrphanedJobs(d);
  expect(d.emitOrphansReprovisioned).not.toHaveBeenCalled();
});
