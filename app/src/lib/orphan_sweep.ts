import type { JobsRepo } from './jobs';
import type { ControlMessage } from './types';

/**
 * Orphaned-job sweep: re-provision queued jobs whose webhook was already consumed.
 *
 * Why this exists (incident 2026-07-26): the control plane provisions exactly one VM
 * per `workflow_job.queued` webhook, but GitHub schedules JIT runners as a LABEL POOL —
 * a runner minted for job A can be handed job B. When that happens, job B's own
 * provision self-cancels ("run no longer queued"), the pool ends up one VM short, and
 * job A sits queued with no future trigger: nothing in the system ever looked at
 * GitHub's queue again. Observed: a job orphaned for 2h38m, healed only by unrelated
 * traffic minting surplus VMs.
 *
 * The invariant this restores is pool-level, not per-job: every label-matching job
 * queued on GitHub past a threshold must have a provision in flight. GitHub's
 * `status == queued` is the authoritative "unserved" signal — it outranks our own
 * JobRecord, which the incident proved can lie (the orphan's record said `running`
 * while its VM served a different job).
 *
 * Safety posture mirrors the reaping half of the reconciler: act only on positive
 * evidence (a 200 from GitHub saying the job is queued and old), contain per-repo
 * failures, and never throw — absence of evidence is not evidence of an orphan.
 * Duplicate provisions are harmless: control's beginProvisioning claim is idempotent.
 */

/** A queued (unserved) workflow job as reported by GitHub. */
export interface QueuedJobInfo {
  jobId: string;
  runId: number;
  labels: string[];
  /** Job creation time, epoch seconds — the start of its wait. */
  queuedAt: number;
}

export interface OrphanSweepGithub {
  appJwt(appId: string, privateKeyPem: string): string;
  installationToken(jwt: string, installationId: number): Promise<string>;
  /** All installations of this App, so repos can be matched to a token source. */
  listInstallations(jwt: string): Promise<{ id: number; login: string }[]>;
  /** Queued jobs across the repo's queued AND in_progress runs (matrix runs mix states). */
  listQueuedJobs(token: string, owner: string, repo: string): Promise<QueuedJobInfo[]>;
}

export interface OrphanSweepDeps {
  jobs: JobsRepo;
  github: OrphanSweepGithub;
  loadAppCreds: () => Promise<{ appId: string; privateKey: string }>;
  /**
   * Only exact `owner/repo` entries are sweepable — owner-wide and allowAll
   * deployments have no enumerable repo list. For those, the sweep is a no-op
   * and the webhook path remains the only provision trigger.
   */
  allowedRepos: string[];
  /** Labels a job must request (all of them) to be ours — same rule as the webhook. */
  labels: string[];
  enqueueProvision: (msg: ControlMessage) => Promise<void>;
  /** A job queued longer than this is an orphan. Must exceed the SQS delivery delay + launch time. */
  orphanAfterSeconds: number;
  /**
   * A `running` record younger than this is trusted (its runner may still be
   * registering); older with the job still queued on GitHub means the VM was stolen.
   */
  staleRunningAfterSeconds: number;
  now?: () => number;
  emitOrphansReprovisioned?: (count: number) => Promise<void>;
}

export async function sweepOrphanedJobs(deps: OrphanSweepDeps): Promise<{ reprovisioned: number }> {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  const repos = deps.allowedRepos
    .map((entry) => entry.split('/'))
    .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[0] && !!parts[1]);
  if (repos.length === 0) return { reprovisioned: 0 };

  const { appId, privateKey } = await deps.loadAppCreds();
  const jwt = deps.github.appJwt(appId, privateKey);

  let installations: { id: number; login: string }[];
  try {
    installations = await deps.github.listInstallations(jwt);
  } catch (e) {
    console.error('[orphan-sweep] listInstallations failed — skipping sweep:', e);
    return { reprovisioned: 0 };
  }
  const installationByOwner = new Map(installations.map((i) => [i.login.toLowerCase(), i.id]));
  const tokenCache = new Map<number, string>();

  let reprovisioned = 0;
  for (const [owner, repo] of repos) {
    const installationId = installationByOwner.get(owner.toLowerCase());
    if (installationId === undefined) {
      console.warn(`[orphan-sweep] no App installation for owner=${owner} — skipping ${owner}/${repo}`);
      continue;
    }
    try {
      let token = tokenCache.get(installationId);
      if (!token) {
        token = await deps.github.installationToken(jwt, installationId);
        tokenCache.set(installationId, token);
      }
      const queued = await deps.github.listQueuedJobs(token, owner, repo);
      for (const job of queued) {
        if (!deps.labels.every((l) => job.labels.includes(l))) continue;
        if (now - job.queuedAt < deps.orphanAfterSeconds) continue; // normal pickup window
        const rec = await deps.jobs.getJob(job.jobId);
        if (rec?.state === 'provisioning') continue; // control is mid-flight on it
        if (rec?.state === 'running') {
          if (now - rec.updatedAt < deps.staleRunningAfterSeconds) continue; // runner still registering
          // The record is provably a lie: GitHub says the job is unserved, so the VM this
          // record points at is serving some OTHER job (label-pool steal). Never terminate
          // it — that could kill a live job; the platform's max-runtime cap bounds the VM.
          console.warn(
            `[orphan-sweep] stale running record for queued job=${job.jobId} (microvm=${rec.microvmId ?? 'none'} was stolen) — deleting record and re-provisioning`,
          );
          await deps.jobs.deleteJob(job.jobId);
        }
        const msg: ControlMessage = {
          type: 'provision',
          jobId: job.jobId,
          runId: job.runId,
          installationId,
          owner,
          repo,
          labels: job.labels,
        };
        await deps.enqueueProvision(msg);
        reprovisioned += 1;
        console.log(
          `[orphan-sweep] re-enqueued provision job=${job.jobId} ${owner}/${repo} (queued ${now - job.queuedAt}s)`,
        );
      }
    } catch (e) {
      console.error(`[orphan-sweep] sweep failed for ${owner}/${repo} — contained:`, e);
    }
  }

  if (reprovisioned > 0 && deps.emitOrphansReprovisioned) {
    await deps.emitOrphansReprovisioned(reprovisioned);
  }
  return { reprovisioned };
}
