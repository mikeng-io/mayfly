#!/usr/bin/env bash
# Optional helper: create the S3 artifact bucket + IAM build role for image builds.
# Needs S3 + IAM permissions. Prints BUILD_ROLE_ARN to paste into config.env.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.env
: "${AWS_REGION:?}"; : "${S3_BUCKET:?}"
ROLE_NAME="${ROLE_NAME:-MayflyMicrovmBuildRole}"

echo "[setup] S3 bucket $S3_BUCKET…"
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "  exists"
elif [ "$AWS_REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION"
else
  aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
fi

echo "[setup] IAM build role $ROLE_NAME…"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}'
aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 \
  || aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" >/dev/null
PERM="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$S3_BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:*:*:*\"}]}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name mayfly-build --policy-document "$PERM"

ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)
echo "[setup] done. Put this in config.env:"
echo "  BUILD_ROLE_ARN=$ARN"
