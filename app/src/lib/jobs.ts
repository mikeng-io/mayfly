import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { JobRecord, JobState } from './types';

export interface JobsRepoOptions {
  table: string;
  stateIndex: string;
  /** A `provisioning` record older than this is considered a crashed attempt and re-claimable. */
  provisionTtlSeconds: number;
  /** DynamoDB TTL horizon for a record. */
  recordTtlSeconds: number;
  region?: string;
  now?: () => number;
}

export interface JobsRepo {
  beginProvisioning(jobId: string, runId: number, owner?: string): Promise<'proceed' | 'skip'>;
  attachMicrovm(jobId: string, microvmId: string, endpoint: string): Promise<void>;
  markRunning(jobId: string, runnerName?: string, trust?: 'internal' | 'fork'): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | undefined>;
  deleteJob(jobId: string): Promise<void>;
  listByState(state: JobState): Promise<JobRecord[]>;
  /** Count active (provisioning+running) MicroVMs held by one owner (per-owner quota). */
  countActiveByOwner(owner: string): Promise<number>;
  setFirstSeenOverdue(jobId: string): Promise<number>;
}

let doc: DynamoDBDocumentClient | undefined;
function client(region?: string): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: region ?? process.env.MAYFLY_REGION }));
  return doc;
}

export function createJobsRepo(opts: JobsRepoOptions): JobsRepo {
  const db = client(opts.region);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const T = opts.table;

  const queryByState = async (state: JobState): Promise<JobRecord[]> => {
    const res = await db.send(
      new QueryCommand({
        TableName: T,
        IndexName: opts.stateIndex,
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':s': state },
      }),
    );
    return (res.Items ?? []) as JobRecord[];
  };

  return {
    /**
     * Re-drivable claim. Succeeds ("proceed") only if no record exists, or an existing
     * `provisioning` record is stale (a crashed prior attempt). A fresh `provisioning`
     * or a `running` record → "skip", which dedupes SQS at-least-once redelivery.
     */
    async beginProvisioning(jobId, runId, owner) {
      const t = now();
      const rec: JobRecord = {
        jobId,
        runId,
        owner,
        state: 'provisioning',
        createdAt: t,
        updatedAt: t,
        expiresAt: t + opts.recordTtlSeconds,
      };
      try {
        await db.send(
          new PutCommand({
            TableName: T,
            Item: rec,
            ConditionExpression:
              'attribute_not_exists(jobId) OR (#s = :prov AND updatedAt < :stale)',
            ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: {
              ':prov': 'provisioning',
              ':stale': t - opts.provisionTtlSeconds,
            },
          }),
        );
        return 'proceed';
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return 'skip';
        throw e;
      }
    },

    async attachMicrovm(jobId, microvmId, endpoint) {
      await db.send(
        new UpdateCommand({
          TableName: T,
          Key: { jobId },
          UpdateExpression: 'SET microvmId = :m, endpoint = :e, updatedAt = :t',
          ExpressionAttributeValues: { ':m': microvmId, ':e': endpoint, ':t': now() },
        }),
      );
    },

    async markRunning(jobId, runnerName, trust) {
      const values: Record<string, unknown> = { ':r': 'running', ':t': now() };
      let expr = 'SET #s = :r, updatedAt = :t';
      if (runnerName) {
        expr += ', runnerName = :n';
        values[':n'] = runnerName;
      }
      if (trust) {
        expr += ', trust = :tr';
        values[':tr'] = trust;
      }
      await db.send(
        new UpdateCommand({
          TableName: T,
          Key: { jobId },
          UpdateExpression: expr,
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: values,
        }),
      );
    },

    async getJob(jobId) {
      const res = await db.send(new GetCommand({ TableName: T, Key: { jobId } }));
      return res.Item as JobRecord | undefined;
    },

    async deleteJob(jobId) {
      await db.send(new DeleteCommand({ TableName: T, Key: { jobId } }));
    },

    listByState: queryByState,

    async countActiveByOwner(owner) {
      const active = [...(await queryByState('provisioning')), ...(await queryByState('running'))];
      return active.filter((r) => r.owner === owner).length;
    },

    /** Set the reconciler's grace-window marker once; returns the effective marker time. */
    async setFirstSeenOverdue(jobId) {
      const t = now();
      const res = await db.send(
        new UpdateCommand({
          TableName: T,
          Key: { jobId },
          UpdateExpression:
            'SET firstSeenOverdue = if_not_exists(firstSeenOverdue, :t), updatedAt = :t',
          ExpressionAttributeValues: { ':t': t },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (res.Attributes as JobRecord).firstSeenOverdue ?? t;
    },
  };
}
