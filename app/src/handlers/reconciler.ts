import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { loadConfig } from '../lib/config';
import { createJobsRepo, type JobsRepo } from '../lib/jobs';
import { createAttestationsRepo, type AttestationsRepo } from '../lib/attestations';
import { createMicrovmClient, type MicrovmClient } from '../lib/microvm';
import type { JobState } from '../lib/types';

/** Must match the CloudWatch alarm in the CDK stack (METRIC_NAMESPACE / RECLAIMED_METRIC). */
export const METRIC_NAMESPACE = 'Mayfly';
export const RECLAIMED_METRIC = 'ReclaimedMicrovms';

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

/** SNS/alarm-visible metric so a leak is never silent. */
async function emitReclaimed(count: number, region: string): Promise<void> {
  cw ??= new CloudWatchClient({ region });
  await cw.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: RECLAIMED_METRIC, Value: count, Unit: 'Count' }],
    }),
  );
}

/** EventBridge Scheduler target (no event payload needed). */
export async function handler(): Promise<{ reclaimed: number }> {
  const cfg = loadConfig();
  return reconcile({
    jobs: createJobsRepo({
      table: cfg.jobsTable,
      stateIndex: cfg.jobsStateIndex,
      provisionTtlSeconds: cfg.provisionTtlSeconds,
      recordTtlSeconds: RECORD_TTL_SECONDS,
      region: cfg.region,
    }),
    attestations: createAttestationsRepo({
      table: cfg.attestationsTable,
      ttlSeconds: ATTESTATION_TTL_SECONDS,
      region: cfg.region,
    }),
    microvm: createMicrovmClient({ region: cfg.region, maxRuntimeSeconds: cfg.maxRuntimeSeconds }),
    maxRuntimeSeconds: cfg.maxRuntimeSeconds,
    graceSeconds: 120,
    emitReclaimed: (count) => emitReclaimed(count, cfg.region),
  });
}
