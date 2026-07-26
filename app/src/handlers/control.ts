import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { loadConfig, getSecret, getSecretsManagerValue } from '../lib/config';
import { createJobsRepo, type JobsRepo } from '../lib/jobs';
import { createAttestationsRepo, type AttestationsRepo } from '../lib/attestations';
import { createMicrovmClient, type MicrovmClient } from '../lib/microvm';
import {
  appJwt,
  installationToken,
  generateJitConfig,
  getRun,
  isForkPR,
  type RunInfo,
} from '../lib/github';
import type { ControlMessage } from '../lib/types';

/** How long a completed/abandoned record lingers (DynamoDB TTL) — well past max runtime. */
const RECORD_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long VM-identity evidence is kept. Long enough that a claim made in a write-up
 * can still be checked against it — the jobs table's 24h would have expired before
 * anyone went looking.
 */
const ATTESTATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Delay before a quota-deferred provision is retried. */
const REQUEUE_DELAY_SECONDS = 60;

export interface GithubApi {
  appJwt: typeof appJwt;
  installationToken: typeof installationToken;
  generateJitConfig: typeof generateJitConfig;
  getRun: typeof getRun;
  isForkPR: typeof isForkPR;
}

export interface ControlDeps {
  jobs: JobsRepo;
  /** Durable (microvmId -> runnerName) evidence; outlives the job record. */
  attestations: AttestationsRepo;
  microvm: MicrovmClient;
  github: GithubApi;
  loadAppCreds: () => Promise<{ appId: string; privateKey: string }>;
  imageName: string;
  /** Max concurrent MicroVMs one owner may hold; over-quota provisions are re-queued. */
  perOwnerConcurrency: number;
  /** Re-queue an over-quota provision (delayed) instead of launching now. */
  requeue: (msg: ControlMessage, delaySeconds: number) => Promise<void>;
  maxRequeues: number;
  /** Surface a dropped-over-quota job (so it isn't silent data loss). */
  emitQuotaDrop?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

const isThrottle = (e: unknown): boolean =>
  /Throttl|TooManyRequests|RequestLimit/i.test((e as { name?: string }).name ?? '');

/** Retry RunMicrovm (which is TPS-limited ~5/s) on throttling with jittered backoff. */
async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  jobId: string,
): Promise<T> {
  let delay = 200;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isThrottle(e)) throw e;
      // Deterministic-ish jitter from the jobId so tests don't need Math.random.
      const jitter = (jobId.length * 37) % 100;
      await sleep(delay + jitter);
      delay *= 2;
    }
  }
}

async function provision(msg: Extract<ControlMessage, { type: 'provision' }>, deps: ControlDeps): Promise<void> {
  // 0. Per-owner quota (fairness/abuse): if the owner is at their cap, defer this job via a
  //    delayed re-queue rather than launching — natural backpressure that doesn't burn the SQS
  //    retry/DLQ budget. Bounded by maxRequeues so it can't loop forever.
  const active = await deps.jobs.countActiveByOwner(msg.owner);
  if (active >= deps.perOwnerConcurrency) {
    const attempts = (msg.attempts ?? 0) + 1;
    if (attempts <= deps.maxRequeues) {
      console.log(`[control] quota defer: ${msg.owner} at ${active}/${deps.perOwnerConcurrency}, requeue #${attempts} job=${msg.jobId}`);
      await deps.requeue({ ...msg, attempts }, REQUEUE_DELAY_SECONDS);
      return;
    }
    console.warn(
      `[control] quota DROP: job ${msg.jobId} for ${msg.owner} after ${attempts - 1} requeues (limit ${deps.perOwnerConcurrency})`,
    );
    await deps.emitQuotaDrop?.();
    return;
  }

  // 1. Re-drivable idempotency claim. "skip" = SQS redelivery / already handled.
  if ((await deps.jobs.beginProvisioning(msg.jobId, msg.runId, msg.owner)) === 'skip') {
    console.log(`[control] skip (already handled) job=${msg.jobId}`);
    return;
  }
  console.log(`[control] provisioning job=${msg.jobId} owner=${msg.owner} run=${msg.runId}`);

  // 2. Auth + re-check the run is still queued (handles completed-before-provision).
  const { appId, privateKey } = await deps.loadAppCreds();
  const jwt = deps.github.appJwt(appId, privateKey);
  const token = await deps.github.installationToken(jwt, msg.installationId);

  let run: RunInfo | undefined;
  let getRunFailed = false;
  try {
    run = await deps.github.getRun(token, msg.owner, msg.repo, msg.runId);
  } catch {
    getRunFailed = true;
  }
  if (run && run.status !== 'queued') {
    await deps.jobs.deleteJob(msg.jobId);
    return;
  }

  // 3. Fork-check, FAIL-CLOSED: trust is "internal" only if we positively confirmed a
  //    non-fork run; any failure/uncertainty => "fork". v1 records trust; the VPC-SG
  //    network gate is a documented post-v1 deferral.
  const trust: 'internal' | 'fork' =
    !getRunFailed && run && !deps.github.isForkPR(run) ? 'internal' : 'fork';

  // 4. Launch, and record the microvmId IMMEDIATELY so a redelivery/reconciler can reap it.
  const imageArn = await deps.microvm.imageArn(deps.imageName);
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const { microvmId, endpoint } = await withThrottleRetry(
    () => deps.microvm.runMicrovm(imageArn, msg.jobId),
    deps.retries ?? 4,
    sleep,
    msg.jobId,
  );
  await deps.jobs.attachMicrovm(msg.jobId, microvmId, endpoint);
  console.log(`[control] launched microvm=${microvmId} job=${msg.jobId} trust=${trust}`);

  // 5. Everything past here can leak the VM on failure -> terminate in the catch.
  try {
    await deps.microvm.waitRunning(microvmId);
    const auth = await deps.microvm.authToken(microvmId);
    const runnerName = `mayfly-${msg.jobId}`;
    const jit = await deps.github.generateJitConfig(token, msg.owner, msg.repo, runnerName, msg.labels);
    // Attest BEFORE postJit, not after. postJit returns 202 and the launcher immediately
    // execs run.sh, so the runner is registering with GitHub the moment it returns — a
    // failed write after that point would terminate a VM with a live job in it, and the
    // retry could not recover (the JIT runner name is still registered, so regenerating
    // it fails and the message walks to the DLQ). Attesting first is also strictly
    // better evidence: the job cannot have emitted anything yet.
    await deps.attestations.record({ microvmId, jobId: msg.jobId, runnerName, trust });
    await deps.microvm.postJit(endpoint, auth, jit, microvmId);
    await deps.jobs.markRunning(msg.jobId, runnerName, trust);
    console.log(`[control] running job=${msg.jobId} microvm=${microvmId} runner=${runnerName}`);
  } catch (e) {
    console.error(`[control] provision failed job=${msg.jobId} microvm=${microvmId} — terminating:`, e);
    await deps.microvm.terminate(microvmId);
    // Close the attestation if we got as far as writing one; a VM we killed must not leave
    // evidence that reads as still-running. Best-effort — the original error must be the one
    // that surfaces — but log rather than discard: markTerminated already swallows the
    // expected "nothing to close" case, so anything reaching here is a real fault, and a
    // bare catch would drop the only signal that evidence is going missing.
    await deps.attestations
      .markTerminated(microvmId)
      .catch((err) => console.error(`[control] attestation close failed microvm=${microvmId}:`, err));
    throw e; // surface to SQS: retry, then DLQ
  }
}

async function teardown(msg: Extract<ControlMessage, { type: 'teardown' }>, deps: ControlDeps): Promise<void> {
  const rec = await deps.jobs.getJob(msg.jobId);
  if (rec?.microvmId) {
    await deps.microvm.terminate(rec.microvmId);
    // Stamp, don't delete. The job record goes away below because the state machine is
    // done with it; the evidence that this VM served this runner has to outlive it.
    await deps.attestations.markTerminated(rec.microvmId);
  }
  await deps.jobs.deleteJob(msg.jobId);
  console.log(`[control] teardown job=${msg.jobId} microvm=${rec?.microvmId ?? 'none'}`);
}

/** Process one control message (exported for unit tests). */
export async function processMessage(msg: ControlMessage, deps: ControlDeps): Promise<void> {
  if (msg.type === 'provision') return provision(msg, deps);
  if (msg.type === 'teardown') return teardown(msg, deps);
}

function buildDeps(): ControlDeps {
  const cfg = loadConfig();
  const sqs = new SQSClient({ region: cfg.region });
  const cw = new CloudWatchClient({ region: cfg.region });
  return {
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
    github: { appJwt, installationToken, generateJitConfig, getRun, isForkPR },
    loadAppCreds: async () => ({
      appId: await getSecret(cfg.appIdParam),
      privateKey: await getSecretsManagerValue(cfg.appKeyParam),
    }),
    imageName: cfg.imageName,
    perOwnerConcurrency: cfg.perOwnerConcurrency,
    maxRequeues: cfg.maxRequeues,
    requeue: async (m, delaySeconds) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: cfg.queueUrl,
          MessageBody: JSON.stringify(m),
          DelaySeconds: delaySeconds,
        }),
      );
    },
    emitQuotaDrop: async () => {
      await cw.send(
        new PutMetricDataCommand({
          Namespace: 'Mayfly',
          MetricData: [{ MetricName: 'QuotaDropped', Value: 1, Unit: 'Count' }],
        }),
      );
    },
  };
}

/** SQS event source handler (batchSize 1). */
export async function handler(event: { Records: { body: string }[] }): Promise<void> {
  const deps = buildDeps();
  for (const record of event.Records) {
    await processMessage(JSON.parse(record.body) as ControlMessage, deps);
  }
}
