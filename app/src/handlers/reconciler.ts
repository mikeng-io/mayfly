import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig, getSecret, getSecretsManagerValue } from '../lib/config';
import { createJobsRepo, type JobsRepo } from '../lib/jobs';
import { createAttestationsRepo, type AttestationsRepo } from '../lib/attestations';
import { createMicrovmClient, type MicrovmClient } from '../lib/microvm';
import { sweepOrphanedJobs } from '../lib/orphan_sweep';
import { appJwt, installationToken, listInstallations, listQueuedJobs } from '../lib/github';
import type { JobState } from '../lib/types';

/** Must match the CloudWatch alarms in the CDK stack (METRIC_NAMESPACE / *_METRIC). */
export const METRIC_NAMESPACE = 'Mayfly';
export const RECLAIMED_METRIC = 'ReclaimedMicrovms';
export const ORPHANS_METRIC = 'OrphanedJobsReprovisioned';

/**
 * A job queued on GitHub longer than this with no in-flight provision is an orphan
 * (its webhook-minted VM was stolen by GitHub's label-pool scheduler — incident
 * 2026-07-26). Must exceed the SQS delivery delay (20s) + launch + registration
 * (~60s worst case healthy); at 180s a healthy job can never be double-provisioned.
 */
const ORPHAN_AFTER_SECONDS = 180;
/** A `running` record younger than this is trusted — its runner may still be registering. */
const STALE_RUNNING_AFTER_SECONDS = 120;

const RECORD_TTL_SECONDS = 24 * 60 * 60;
/** Must match control.ts — evidence retention, not operational state. */
const ATTESTATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTIVE_STATES: JobState[] = ['provisioning', 'running'];
const TERMINAL_VM = new Set(['TERMINATED', 'TERMINATING']);

export interface ReconcilerDeps {
  jobs: JobsRepo;
  /** Optional: stamp terminatedAt so reaped VMs don't leave evidence that never closes. */
  attestations?: AttestationsRepo;
  microvm: MicrovmClient;
  maxRuntimeSeconds: number;
  /** Grace window: a record must be seen overdue across this span before we reap it. */
  graceSeconds: number;
  now?: () => number;
  emitReclaimed?: (count: number) => Promise<void>;
}

/**
 * Account-safe reconciler. It iterates ONLY our own JobRecords (every launched
 * microvmId was recorded via attachMicrovm) — it never enumerates and terminates
 * MicroVMs region-wide, which could kill unrelated VMs in the account.
 *
 * Returns the number of leaked (overdue + still-alive) VMs actually reclaimed.
 */
export async function reconcile(deps: ReconcilerDeps): Promise<{ reclaimed: number }> {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  let reclaimed = 0;

  for (const state of ACTIVE_STATES) {
    const records = await deps.jobs.listByState(state);
    for (const rec of records) {
      const overdue = now >= rec.createdAt + deps.maxRuntimeSeconds;

      // Is the VM already gone?
      let vmGone = !rec.microvmId && overdue; // stale provisioning record that never attached a VM
      if (rec.microvmId) {
        const info = await deps.microvm.getMicrovm(rec.microvmId).catch(() => ({ state: undefined }));
        vmGone = !info.state || TERMINAL_VM.has(info.state);
      }

      if (vmGone) {
        // Cleanup only — the VM is already gone, so this is not a leak reclaim.
        if (rec.microvmId) {
          await deps.microvm.terminate(rec.microvmId);
          await deps.attestations?.markTerminated(rec.microvmId);
        }
        await deps.jobs.deleteJob(rec.jobId);
        continue;
      }

      if (!overdue) continue; // healthy, in-flight — leave it

      // Overdue AND still alive: apply the two-phase grace window before reaping.
      const firstSeen = rec.firstSeenOverdue ?? (await deps.jobs.setFirstSeenOverdue(rec.jobId));
      if (now - firstSeen < deps.graceSeconds) continue; // wait one more sweep

      await deps.microvm.terminate(rec.microvmId!);
      await deps.attestations?.markTerminated(rec.microvmId!);
      await deps.jobs.deleteJob(rec.jobId);
      reclaimed += 1; // a real leak: the control path missed a teardown
    }
  }

  if (reclaimed > 0 && deps.emitReclaimed) await deps.emitReclaimed(reclaimed);
  return { reclaimed };
}

let cw: CloudWatchClient | undefined;

/** SNS/alarm-visible metric so a leak or an orphan repair is never silent. */
async function emitMetric(metric: string, count: number, region: string): Promise<void> {
  cw ??= new CloudWatchClient({ region });
  await cw.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: metric, Value: count, Unit: 'Count' }],
    }),
  );
}

/** EventBridge Scheduler target (no event payload needed). */
export async function handler(): Promise<{ reclaimed: number; reprovisioned: number }> {
  const cfg = loadConfig();
  const jobs = createJobsRepo({
    table: cfg.jobsTable,
    stateIndex: cfg.jobsStateIndex,
    provisionTtlSeconds: cfg.provisionTtlSeconds,
    recordTtlSeconds: RECORD_TTL_SECONDS,
    region: cfg.region,
  });

  const { reclaimed } = await reconcile({
    jobs,
    attestations: createAttestationsRepo({
      table: cfg.attestationsTable,
      ttlSeconds: ATTESTATION_TTL_SECONDS,
      region: cfg.region,
    }),
    microvm: createMicrovmClient({ region: cfg.region, maxRuntimeSeconds: cfg.maxRuntimeSeconds }),
    maxRuntimeSeconds: cfg.maxRuntimeSeconds,
    graceSeconds: 120,
    emitReclaimed: (count) => emitMetric(RECLAIMED_METRIC, count, cfg.region),
  });

  // The other half of reconciliation: repair GitHub's queue, not just our VMs. Contained
  // so a sweep failure can never break the reaping above (and vice versa — reap ran first).
  let reprovisioned = 0;
  try {
    const sqs = new SQSClient({ region: cfg.region });
    ({ reprovisioned } = await sweepOrphanedJobs({
      jobs,
      github: { appJwt, installationToken, listInstallations, listQueuedJobs },
      loadAppCreds: async () => ({
        appId: await getSecret(cfg.appIdParam),
        privateKey: await getSecretsManagerValue(cfg.appKeyParam),
      }),
      allowedRepos: cfg.allowedRepos,
      labels: cfg.labels,
      enqueueProvision: async (msg) => {
        await sqs.send(
          new SendMessageCommand({ QueueUrl: cfg.queueUrl, MessageBody: JSON.stringify(msg) }),
        );
      },
      orphanAfterSeconds: ORPHAN_AFTER_SECONDS,
      staleRunningAfterSeconds: STALE_RUNNING_AFTER_SECONDS,
      emitOrphansReprovisioned: (count) => emitMetric(ORPHANS_METRIC, count, cfg.region),
    }));
  } catch (e) {
    console.error('[reconciler] orphan sweep failed — contained:', e);
  }

  return { reclaimed, reprovisioned };
}
