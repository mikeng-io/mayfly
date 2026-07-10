#!/usr/bin/env bash
# Build/update the Mayfly MicroVM runner image:
#   stage build context -> zip -> S3 -> (create|update)-microvm-image
#   -> wait for image CREATED|UPDATED AND version SUCCESSFUL.
#
# Prereqs: `cd infra && npm run deploy` (writes ../cdk-outputs.json with the
# ArtifactBucketName + BuildRoleArn), AWS creds in the repo .env, jq, zip.
#
#   ./build-image.sh                 # lean runner image (default)
#   IMAGE_NAME=mayfly-runner ./build-image.sh
set -euo pipefail
cd "$(dirname "$0")"

# AWS creds from the repo .env (may set a default region); pin AWS_REGION after so Tokyo wins.
set -a; . ../.env; set +a
AWS_REGION="${MAYFLY_REGION:-ap-northeast-1}"
: "${AWS_REGION:?}"

OUT=./cdk-outputs.json
[ -f "$OUT" ] || { echo "[build] missing $OUT — deploy infra first: (cd infra && npm run deploy)"; exit 1; }
S3_BUCKET=$(jq -r '.MayflyStack.ArtifactBucketName' "$OUT")
BUILD_ROLE_ARN=$(jq -r '.MayflyStack.BuildRoleArn' "$OUT")
: "${S3_BUCKET:?bucket from CDK outputs}"; : "${BUILD_ROLE_ARN:?role from CDK outputs}"

IMAGE_NAME="${IMAGE_NAME:-mayfly-runner}"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1}"
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }

# Stage the build context so the Dockerfile sits at the zip root (AWS builds the
# final stage = the lean `runner`). COPY paths in the Dockerfile are honored.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE" app.zip' EXIT
cp image/Dockerfile "$STAGE/Dockerfile"
mkdir -p "$STAGE/runtime/launcher"
cp runtime/launcher/main.go "$STAGE/runtime/launcher/main.go"

KEY="mayfly/app-$(date +%s).zip"   # unique key per build so update always ships new code
echo "[build] zipping context…"; ( cd "$STAGE" && zip -qr "$OLDPWD/app.zip" Dockerfile runtime )
echo "[build] upload s3://$S3_BUCKET/$KEY"; aws s3 cp app.zip "s3://$S3_BUCKET/$KEY" --region "$AWS_REGION" >/dev/null

# The /ready hook port + readyTimeoutInSeconds flags (if the build needs them) can be
# supplied via MAYFLY_HOOKS_ARGS, e.g. export MAYFLY_HOOKS_ARGS='--hooks {"port":8080,"readyTimeoutInSeconds":180}'.
# Left empty by default (the spike built without --hooks).
read -r -a HOOKS_ARGS <<< "${MAYFLY_HOOKS_ARGS:-}"

if LM get-microvm-image --image-identifier "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "[build] image exists → update-microvm-image…"
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

echo -n "[build] waiting for build (runs the Dockerfile in AWS; a few min)"
built=0
for _ in $(seq 1 80); do
  imgst=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query state --output text 2>/dev/null || echo '?')
  echo -n " $imgst"
  case "$imgst" in
    CREATED|UPDATED) echo; built=1; break ;;
    CREATION_FAILED|UPDATE_FAILED) echo; echo "[build] FAILED ($imgst) — logs: /aws/lambda/microvms/$IMAGE_NAME"; exit 1 ;;
  esac
  sleep 15
done
[ "$built" = 1 ] || { echo; echo "[build] TIMEOUT waiting for build"; exit 1; }

# A CREATED/UPDATED image can still hold a FAILED version — check the version state.
verst=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query 'latestVersion.state' --output text 2>/dev/null || echo '?')
[ "$verst" = SUCCESSFUL ] || { echo "[build] image built but version state=$verst (expected SUCCESSFUL)"; exit 1; }

IMAGE_ARN=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'].imageArn | [0]" --output text)
echo "[build] ✓ image ready: $IMAGE_NAME ($IMAGE_ARN), version SUCCESSFUL"
echo "[build]   NOTE: record this image in app/AWS-LEDGER.md (snapshot storage until deleted)."
