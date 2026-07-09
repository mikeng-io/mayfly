import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { verifySignature } from '../lib/hmac';
import { loadConfig, getSecret } from '../lib/config';
import type { ControlMessage, WorkflowJobEvent } from '../lib/types';

const sqs = new SQSClient({ region: process.env.MAYFLY_REGION });
let cachedSecret: string | undefined;

/** Minimal Lambda Function URL event/result shape (we only touch these fields). */
interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
interface FunctionUrlResult {
  statusCode: number;
  body?: string;
}

function header(headers: FunctionUrlEvent['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Stateless webhook receiver. Verify HMAC (over the decoded raw body), filter to
 * queued/completed workflow_job events for our labels, enqueue a control message,
 * and 2xx fast. No provisioning and no DynamoDB here — idempotency is the control
 * Lambda's job.
 */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const cfg = loadConfig();
  cachedSecret ??= await getSecret(cfg.webhookSecretParam);

  // Function URLs may base64-encode the body; decode BEFORE computing the HMAC.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64')
    : Buffer.from(event.body ?? '');

  const sig = header(event.headers, 'x-hub-signature-256');
  if (!verifySignature(cachedSecret, raw, sig)) return { statusCode: 401, body: 'bad signature' };

  let payload: WorkflowJobEvent;
  try {
    payload = JSON.parse(raw.toString('utf8')) as WorkflowJobEvent;
  } catch {
    return { statusCode: 400, body: 'bad json' };
  }

  const { action } = payload;
  if (action !== 'queued' && action !== 'completed') return { statusCode: 200, body: 'ignored' };

  const job = payload.workflow_job;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const installationId = payload.installation?.id ?? 0;
  const jobId = String(job.id);

  if (action === 'queued') {
    // Provision only for jobs whose runs-on requests all of our configured labels.
    const matches = cfg.labels.every((l) => job.labels.includes(l));
    if (!matches) return { statusCode: 200, body: 'label mismatch' };
    const msg: ControlMessage = {
      type: 'provision',
      jobId,
      runId: job.run_id,
      installationId,
      owner,
      repo,
      labels: job.labels,
    };
    await sqs.send(new SendMessageCommand({ QueueUrl: cfg.queueUrl, MessageBody: JSON.stringify(msg) }));
    return { statusCode: 200, body: 'provision enqueued' };
  }

  const msg: ControlMessage = { type: 'teardown', jobId, installationId, owner, repo };
  await sqs.send(new SendMessageCommand({ QueueUrl: cfg.queueUrl, MessageBody: JSON.stringify(msg) }));
  return { statusCode: 200, body: 'teardown enqueued' };
}
