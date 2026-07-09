import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { NagSuppressions } from 'cdk-nag';

/** Custom-metric namespace emitted by the reconciler (Task 11). */
export const METRIC_NAMESPACE = 'Mayfly';
export const RECLAIMED_METRIC = 'ReclaimedMicrovms';
export const JOBS_STATE_INDEX = 'state-index';

/**
 * Mayfly control-plane stack (v1, single region — Tokyo).
 * Task 6 lays down the durable state + queue + config + alarms; Tasks 7/10/11
 * attach the webhook, control, and reconciler Lambdas onto these members.
 */
export class MayflyStack extends Stack {
  readonly jobsTable: dynamodb.Table;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly webhookSecretParam: ssm.StringParameter;
  readonly appIdParam: ssm.StringParameter;
  readonly installationIdParam: ssm.StringParameter;
  readonly appPrivateKey: secretsmanager.Secret;
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- State: correlation table (PK jobId) + GSI on state for the reconciler ---
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY, // v1 dev; state is reconstructable
    });
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: JOBS_STATE_INDEX,
      partitionKey: { name: 'state', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Queue: webhook -> control, with a short delay + DLQ ---
    this.deadLetterQueue = new sqs.Queue(this, 'JobsDLQ', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    this.queue = new sqs.Queue(this, 'JobsQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(300),
      deliveryDelay: Duration.seconds(20), // let GitHub settle before we provision
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    // --- Config: non-secret ids in SSM, the RSA private key in Secrets Manager ---
    // Placeholder values; operators overwrite out-of-band at deploy time (Task 12).
    this.webhookSecretParam = new ssm.StringParameter(this, 'WebhookSecretParam', {
      parameterName: '/mayfly/webhookSecret',
      stringValue: 'REPLACE_ME',
      description: 'GitHub webhook HMAC secret — set the real value out-of-band.',
    });
    this.appIdParam = new ssm.StringParameter(this, 'AppIdParam', {
      parameterName: '/mayfly/appId',
      stringValue: 'REPLACE_ME',
      description: 'GitHub App id.',
    });
    this.installationIdParam = new ssm.StringParameter(this, 'InstallationIdParam', {
      parameterName: '/mayfly/installationId',
      stringValue: 'REPLACE_ME',
      description: 'GitHub App installation id for the target repo.',
    });
    this.appPrivateKey = new secretsmanager.Secret(this, 'AppPrivateKey', {
      secretName: '/mayfly/appPrivateKey',
      description: 'GitHub App RSA private key (PEM) — set the real value out-of-band.',
    });

    // --- Observability: DLQ + reclaim alarms -> SNS ---
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      enforceSSL: true,
      displayName: 'Mayfly control-plane alarms',
    });

    const dlqAlarm = this.deadLetterQueue
      .metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' })
      .createAlarm(this, 'DlqNotEmptyAlarm', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'A control message failed all retries and landed in the DLQ.',
      });
    dlqAlarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));

    const reclaimAlarm = new cw.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: RECLAIMED_METRIC,
      statistic: 'Sum',
      period: Duration.minutes(5),
    }).createAlarm(this, 'ReclaimAlarm', {
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The reconciler reclaimed a leaked MicroVM — the control path missed a teardown.',
    });
    reclaimAlarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));

    this.applyNagSuppressions();
  }

  /** Documented v1 cdk-nag suppressions. */
  private applyNagSuppressions(): void {
    NagSuppressions.addResourceSuppressions(this.deadLetterQueue, [
      { id: 'AwsSolutions-SQS3', reason: 'This queue IS the dead-letter queue; it does not need its own DLQ.' },
    ]);
    NagSuppressions.addResourceSuppressions(this.appPrivateKey, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'GitHub App key rotation is a manual GitHub-side operation, performed out-of-band; automatic rotation is not applicable.',
      },
    ]);
  }
}
