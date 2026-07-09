#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { MayflyStack } from '../lib/mayfly-stack';

const app = new cdk.App();

// MicroVMs are only in GA regions; pin to Tokyo. The account default region differs.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.MAYFLY_REGION ?? 'ap-northeast-1',
};

new MayflyStack(app, 'MayflyStack', {
  env,
  tags: { project: 'mayfly' },
});

// cdk-nag: fail synth on AwsSolutions violations unless explicitly suppressed.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
