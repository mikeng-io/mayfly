import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Mayfly control-plane stack (v1, single region — Tokyo).
 *
 * Built up task-by-task:
 *   Task 6  — DynamoDB table (+ state GSI), SQS queue + DLQ, SSM params, alarms
 *   Task 7  — webhook Lambda + Function URL
 *   Task 10 — control Lambda + SQS event source (reserved concurrency, least-priv IAM)
 *   Task 11 — reconciler Lambda + EventBridge Scheduler
 */
export class MayflyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // Resources are added in later tasks.
  }
}
