import { test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MayflyStack } from '../lib/mayfly-stack';

function synth(): Template {
  const app = new App();
  const stack = new MayflyStack(app, 'TestStack', { env: { region: 'ap-northeast-1' } });
  return Template.fromStack(stack);
}

test('jobs table has PK jobId, PITR, TTL, and the state-index GSI', () => {
  const t = synth();
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: Match.arrayWith([{ AttributeName: 'jobId', KeyType: 'HASH' }]),
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'state-index',
        KeySchema: [{ AttributeName: 'state', KeyType: 'HASH' }],
      }),
    ]),
  });
});

test('main queue has a 20s delay, 300s visibility, and a DLQ redrive policy', () => {
  const t = synth();
  t.hasResourceProperties('AWS::SQS::Queue', {
    DelaySeconds: 20,
    VisibilityTimeout: 300,
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
  });
});

test('there are two queues (main + DLQ)', () => {
  synth().resourceCountIs('AWS::SQS::Queue', 2);
});

test('a DLQ-not-empty CloudWatch alarm exists', () => {
  const t = synth();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    Threshold: 1,
  });
});

test('a reclaim alarm watches the custom Mayfly metric', () => {
  const t = synth();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ReclaimedMicrovms',
    Namespace: 'Mayfly',
  });
});

test('SSM params and the private-key secret are provisioned', () => {
  const t = synth();
  t.resourceCountIs('AWS::SSM::Parameter', 3);
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
});

test('a webhook Lambda with a public (HMAC-authed) Function URL exists', () => {
  const t = synth();
  t.resourceCountIs('AWS::Lambda::Url', 1);
  t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs20.x',
    Architectures: ['arm64'],
  });
});
