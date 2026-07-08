#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MayflySpikeStack } from '../lib/mayfly-spike-stack';

const app = new cdk.App();
new MayflySpikeStack(app, 'MayflySpikeStack', {
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
});
