#!/usr/bin/env bash
# Build/update the Mayfly MicroVM image: zip app -> S3 -> (create|update)-microvm-image
# -> wait for image CREATED|UPDATED AND version SUCCESSFUL.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.env
set -a; . ../../.env; set +a   # AWS creds from repo-root .env (region comes from config.env via --region)
: "${AWS_REGION:?}"
OUT=./cdk-outputs.json
[ -f "$OUT" ] || { echo "[build] missing $OUT — deploy infra first: (cd infra && npm install && npm run deploy)"; exit 1; }
S3_BUCKET=$(jq -r '.MayflySpikeStack.ArtifactBucketName' "$OUT")
BUILD_ROLE_ARN=$(jq -r '.MayflySpikeStack.BuildRoleArn' "$OUT")
: "${S3_BUCKET:?bucket from CDK outputs}"; : "${BUILD_ROLE_ARN:?role from CDK outputs}"
IMAGE_NAME="${IMAGE_NAME:-mayfly-runner}"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1}"
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }

# Unique S3 key per build so update-microvm-image always ships the new code.
KEY="mayfly/app-$(date +%s).zip"
echo "[build] zipping app…"; rm -f app.zip; ( cd app && zip -qr ../app.zip Dockerfile launcher/main.go )
echo "[build] upload s3://$S3_BUCKET/$KEY"; aws s3 cp app.zip "s3://$S3_BUCKET/$KEY" --region "$AWS_REGION" >/dev/null

# Build /ready hook config: AWS snapshots after the app answers /ready 200. The
# exact CLI flag(s) for the hook port + readyTimeoutInSeconds must be confirmed
# once against `aws lambda-microvms create-microvm-image help` (search: hook, port).
# Set them via MAYFLY_HOOKS_ARGS, e.g.:
#   export MAYFLY_HOOKS_ARGS='--hooks {"port":8080,"readyTimeoutInSeconds":180}'
# Left empty for the first attempt (relies on default readiness); if the build
# hangs/fails on readiness, set MAYFLY_HOOKS_ARGS and re-run.
read -r -a HOOKS_ARGS <<< "${MAYFLY_HOOKS_ARGS:-}"

if LM get-microvm-image --image-identifier "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "[build] image exists → update-microvm-image (ships new code)…"
  LM update-microvm-image --image-identifier "$IMAGE_NAME" \
    --code-artifact "uri=s3://$S3_BUCKET/$KEY" \
    --base-image-arn "$BASE_IMAGE_ARN" --build-role-arn "$BUILD_ROLE_ARN" \
    "${HOOKS_ARGS[@]}" >/dev/null
else
  echo "[build] create-microvm-image…"
  LM create-microvm-image --name "$IMAGE_NAME" \
    --code-artifact "uri=s3://$S3_BUCKET/$KEY" \
    --base-image-arn "$BASE_IMAGE_ARN" --build-role-arn "$BUILD_ROLE_ARN" \
    "${HOOKS_ARGS[@]}" >/dev/null
fi

echo -n "[build] waiting for build (runs your Dockerfile in AWS; a few min)"
built=0
for i in $(seq 1 80); do
  imgst=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query state --output text 2>/dev/null || echo '?')
  echo -n " $imgst"
  case "$imgst" in
    CREATED|UPDATED) echo; built=1; break ;;
    CREATION_FAILED|UPDATE_FAILED) echo; echo "[build] FAILED ($imgst) — logs: /aws/lambda/microvms/$IMAGE_NAME"; exit 1 ;;
  esac
  sleep 15
done
[ "$built" = 1 ] || { echo; echo "[build] TIMEOUT waiting for build"; exit 1; }

# Image state CREATED/UPDATED can still hold a FAILED version — check version state.
verst=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query 'latestVersion.state' --output text 2>/dev/null || echo '?')
echo "[build] latest version state: $verst"
case "$verst" in
  SUCCESSFUL) : ;;
  FAILED) echo "[build] version FAILED — logs: /aws/lambda/microvms/$IMAGE_NAME"; exit 1 ;;
  *) echo "[build] WARN: could not read version state (query path may differ from this CLI version); relying on image state" ;;
esac

echo "[build] image ready:"; LM get-microvm-image --image-identifier "$IMAGE_NAME" --query imageArn --output text
