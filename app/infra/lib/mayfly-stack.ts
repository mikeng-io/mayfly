import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';

/** Least-privilege lambda-microvms actions the control plane needs (never `:*`). */
const MICROVM_ACTIONS = [
  'lambda-microvms:RunMicrovm',
  'lambda-microvms:TerminateMicrovm',
  'lambda-microvms:GetMicrovm',
  'lambda-microvms:ListMicrovms',
  'lambda-microvms:ListMicrovmImages',
  'lambda-microvms:GetMicrovmImage',
  'lambda-microvms:CreateMicrovmAuthToken',
];

/** Target repo + runner labels + image name. Overridable per-deploy; sane v1 defaults. */
export interface MayflyStackProps extends StackProps {
  imageName?: string;
  repoOwner?: string;
  repoName?: string;
  labels?: string[];
}

const APP_ROOT = path.join(__dirname, '..', '..');
const HANDLERS_DIR = path.join(APP_ROOT, 'src', 'handlers');
const DEPS_LOCK = path.join(APP_ROOT, 'package-lock.json');

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
  readonly webhookFn: NodejsFunction;
  readonly webhookUrl: lambda.FunctionUrl;
  readonly controlFn: NodejsFunction;

  constructor(scope: Construct, id: string, props?: MayflyStackProps) {
    super(scope, id, props);

    const imageName = props?.imageName ?? 'mayfly-runner';
    const repoOwner = props?.repoOwner ?? 'mikeng-io';
    const repoName = props?.repoName ?? 'mayfly-test';
    const labels = props?.labels ?? ['self-hosted', 'mayfly'];

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

    // --- Shared Lambda config ---
    const commonEnv: Record<string, string> = {
      MAYFLY_REGION: this.region,
      IMAGE_NAME: imageName,
      JOBS_TABLE: this.jobsTable.tableName,
      JOBS_STATE_INDEX: JOBS_STATE_INDEX,
      QUEUE_URL: this.queue.queueUrl,
      REPO_OWNER: repoOwner,
      REPO_NAME: repoName,
      LABELS: labels.join(','),
      WEBHOOK_SECRET_PARAM: this.webhookSecretParam.parameterName,
      APP_ID_PARAM: this.appIdParam.parameterName,
      APP_KEY_PARAM: this.appPrivateKey.secretName,
    };
    const bundling = { minify: true, sourceMap: true, target: 'node20' };

    // --- Webhook Lambda + Function URL (auth NONE; HMAC is the auth) ---
    this.webhookFn = new NodejsFunction(this, 'WebhookFn', {
      entry: path.join(HANDLERS_DIR, 'webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: commonEnv,
      bundling,
      projectRoot: APP_ROOT,
      depsLockFilePath: DEPS_LOCK,
    });
    this.queue.grantSendMessages(this.webhookFn);
    this.webhookSecretParam.grantRead(this.webhookFn);

    this.webhookUrl = this.webhookFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // --- Control Lambda: SQS consumer that provisions/reaps MicroVMs ---
    this.controlFn = new NodejsFunction(this, 'ControlFn', {
      entry: path.join(HANDLERS_DIR, 'control.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(180), // < queue visibility (300s) so a crash redelivers
      // Cap concurrent provisions so a matrix job can't blow past the ~5 TPS RunMicrovm limit.
      reservedConcurrentExecutions: 5,
      environment: { ...commonEnv, MAX_CONCURRENT: '5' },
      bundling,
      projectRoot: APP_ROOT,
      depsLockFilePath: DEPS_LOCK,
    });
    this.controlFn.addEventSource(new SqsEventSource(this.queue, { batchSize: 1 }));
    this.jobsTable.grantReadWriteData(this.controlFn);
    this.appIdParam.grantRead(this.controlFn);
    this.appPrivateKey.grantRead(this.controlFn);
    this.controlFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: MICROVM_ACTIONS, resources: ['*'] }),
    );

    this.applyNagSuppressions();
  }

  /** Documented v1 cdk-nag suppressions. */
  private applyNagSuppressions(): void {
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Node 20.x is a current, supported LTS Lambda runtime standardized across Mayfly; runtime bumps are tracked as a separate maintenance task.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CloudWatch Logs delivery via the AWS-managed AWSLambdaBasicExecutionRole; this is the least-privilege standard for Lambda logging.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    ]);
    NagSuppressions.addResourceSuppressions(
      this.controlFn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'lambda-microvms actions target MicroVM/image ids created at runtime that cannot be enumerated at deploy time (restricted to the 7 required actions, never :*); the DynamoDB grant includes the table GSI (index/*). Both reviewed as least-privilege for v1.',
        },
      ],
      true,
    );
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
