#!/usr/bin/env bash
# Build the Mayfly MicroVM image: zip app -> S3 -> create-microvm-image -> wait CREATED.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.env
: "${AWS_REGION:?}"; : "${S3_BUCKET:?}"; : "${BUILD_ROLE_ARN:?}"
IMAGE_NAME="${IMAGE_NAME:-mayfly-runner}"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1}"
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }

echo "[build] zipping app (Dockerfile + launcher)…"
rm -f app.zip
( cd app && zip -qr ../app.zip Dockerfile launcher/main.go )

echo "[build] uploading to s3://$S3_BUCKET/mayfly/app.zip…"
aws s3 cp app.zip "s3://$S3_BUCKET/mayfly/app.zip" --region "$AWS_REGION"

echo "[build] create-microvm-image (name=$IMAGE_NAME, base=$BASE_IMAGE_ARN)…"
LM create-microvm-image \
  --name "$IMAGE_NAME" \
  --code-artifact "uri=s3://$S3_BUCKET/mayfly/app.zip" \
  --base-image-arn "$BASE_IMAGE_ARN" \
  --build-role-arn "$BUILD_ROLE_ARN" >/dev/null || {
    echo "[build] create-microvm-image errored (image may already exist — building a new version if supported, else delete first)"; }

echo -n "[build] waiting for CREATED (build runs your Dockerfile in AWS; a few min)"
for i in $(seq 1 80); do
  st=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query state --output text 2>/dev/null || echo PENDING)
  echo -n " $st"
  case "$st" in
    CREATED) echo; break ;;
    CREATE_FAILED) echo; echo "[build] FAILED — logs: /aws/lambda/microvms/$IMAGE_NAME (CloudWatch)"; exit 1 ;;
  esac
  sleep 15
done
echo "[build] image ARN:"
LM get-microvm-image --image-identifier "$IMAGE_NAME" --query imageArn --output text
