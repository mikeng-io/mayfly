import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Static infra for the Phase 2 MicroVM spike:
 *   - an S3 bucket to hold the MicroVM image code artifact (the app zip)
 *   - the IAM role Lambda assumes during `create-microvm-image`
 *
 * The MicroVM image build/run themselves are imperative operations
 * (create-microvm-image / run-microvm), driven by the spike scripts — not
 * static resources. Everything that IS a resource lives here, in CDK.
 */
export class MayflySpikeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // spike: tear down cleanly
      autoDeleteObjects: true,
    });

    const buildRole = new iam.Role(this, 'MicrovmBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Mayfly spike: role Lambda assumes to build MicroVM images',
    });
    // MicroVM image builds also require sts:TagSession on the trust policy.
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      }),
    );
    bucket.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:*'],
      }),
    );

    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'BuildRoleArn', { value: buildRole.roleArn });
  }
}
