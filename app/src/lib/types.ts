// Shared types for the Mayfly control plane.

/** GitHub `workflow_job` webhook payload (the subset we consume). */
export interface WorkflowJobEvent {
  action: 'queued' | 'in_progress' | 'completed' | string;
  workflow_job: {
    id: number;
    run_id: number;
    status: string;
    labels: string[];
  };
  repository: {
    // GitHub sends `full_name` "owner/repo"; we also read the nested owner.
    name: string;
    full_name: string;
    owner: { login: string };
  };
  installation?: { id: number };
}

/** Lifecycle state of a job's MicroVM, used as the idempotency/reconciler key. */
export type JobState = 'provisioning' | 'running' | 'done';

/**
 * Correlation record persisted in DynamoDB (PK = jobId).
 * `microvmId` is written the instant `run-microvm` returns so a redelivery or
 * the reconciler can always find and reap the VM.
 */
export interface JobRecord {
  jobId: string;
  runId: number;
  state: JobState;
  microvmId?: string;
  endpoint?: string;
  runnerName?: string;
  trust?: 'internal' | 'fork';
  createdAt: number; // epoch seconds
  updatedAt: number; // epoch seconds
  firstSeenOverdue?: number; // epoch seconds; set by the reconciler's grace window
  expiresAt: number; // epoch seconds; DynamoDB TTL
}

/** Message enqueued by the webhook, consumed by the control Lambda. */
export type ControlMessage =
  | {
      type: 'provision';
      jobId: string;
      runId: number;
      installationId: number;
      owner: string;
      repo: string;
      labels: string[];
    }
  | {
      type: 'teardown';
      jobId: string;
      installationId: number;
      owner: string;
      repo: string;
    };
