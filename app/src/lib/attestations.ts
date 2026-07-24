import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Durable record of which MicroVM served which runner.
 *
 * The jobs table is *operational* state: it is deleted at teardown, by design, because
 * the state machine is finished with it. That deletion also destroys the only evidence
 * that a given GitHub runner ran on a given MicroVM — so "every job got its own VM"
 * becomes unfalsifiable the moment the job ends.
 *
 * This table is *evidence*. It is written when the VM is handed its JIT config and is
 * never deleted by the control plane; teardown only stamps terminatedAt. A receipt
 * claiming `microvmId` can then be checked against a record the control plane wrote
 * before the job produced any output, by someone who does not trust the guest.
 *
 * Distinctness is inherited from RunMicrovm: AWS mints one microvmId per call, and the
 * call is made once per job (clientToken = jobId makes redelivery idempotent, so a
 * retried provision correctly maps to the same VM rather than inventing a second one).
 */
export interface AttestationRecord {
  microvmId: string;
  jobId: string;
  runnerName: string;
  endpoint?: string;
  trust: 'internal' | 'fork';
  launchedAt: number;
  terminatedAt?: number;
  expiresAt: number;
}

export interface AttestationsRepoOptions {
  table: string;
  region?: string;
  /** How long evidence is retained. Far longer than the jobs table's operational TTL. */
  ttlSeconds: number;
  now?: () => number;
}

export interface AttestationsRepo {
  record(a: Omit<AttestationRecord, 'launchedAt' | 'expiresAt' | 'terminatedAt'>): Promise<void>;
  markTerminated(microvmId: string): Promise<void>;
  get(microvmId: string): Promise<AttestationRecord | undefined>;
}

let doc: DynamoDBDocumentClient | undefined;
function client(region?: string): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: region ?? process.env.MAYFLY_REGION }),
  );
  return doc;
}

export function createAttestationsRepo(opts: AttestationsRepoOptions): AttestationsRepo {
  const db = client(opts.region);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const T = opts.table;

  return {
    async record(a) {
      const t = now();
      await db.send(
        new PutCommand({
          TableName: T,
          Item: { ...a, launchedAt: t, expiresAt: t + opts.ttlSeconds } satisfies AttestationRecord,
        }),
      );
    },

    /**
     * Stamp the end of the VM's life. Deliberately an update, not a delete — and
     * conditional, so a teardown for a VM we never attested cannot create a partial
     * record that looks like evidence but has no runner attached to it.
     */
    async markTerminated(microvmId) {
      try {
        await db.send(
          new UpdateCommand({
            TableName: T,
            Key: { microvmId },
            UpdateExpression: 'SET terminatedAt = :t',
            ConditionExpression: 'attribute_exists(microvmId)',
            ExpressionAttributeValues: { ':t': now() },
          }),
        );
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return;
        throw e;
      }
    },

    async get(microvmId) {
      const res = await db.send(new GetCommand({ TableName: T, Key: { microvmId } }));
      return res.Item as AttestationRecord | undefined;
    },
  };
}
