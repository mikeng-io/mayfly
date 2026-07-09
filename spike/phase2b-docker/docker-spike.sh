#!/usr/bin/env bash
# Phase 2b: Docker-in-MicroVM. Build an image with dockerd + ALL OS capabilities,
# run one MicroVM, hand it the docker workflow's JIT, and check docker build/run works.
set -o pipefail
cd "$(dirname "$0")"
set -a; . ../../.env; set +a
export AWS_PAGER=""
AWS_REGION=ap-northeast-1
IMAGE_NAME=mayfly-docker
OWNER=mikeng-io; REPO=mayfly-test; WF=mayfly-docker.yml
GH=https://api.github.com
GA=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
CURL=(curl -s --connect-timeout 10 --max-time 60)
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }
NC="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector"
OUT=../phase2-aws/cdk-outputs.json
S3=$(jq -r .MayflySpikeStack.ArtifactBucketName "$OUT")
ROLE=$(jq -r .MayflySpikeStack.BuildRoleArn "$OUT")
BASE="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"

# ---- build (create or update) with ALL OS capabilities ----
KEY="mayfly/docker-$(date +%s).zip"
echo "[dk] zip + upload…"; rm -f app.zip; ( cd app && zip -qr ../app.zip Dockerfile launcher/main.go )
aws s3 cp app.zip "s3://$S3/$KEY" --region "$AWS_REGION" >/dev/null
N=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'] | length(@)" --output text)
if [ "$N" = "0" ]; then
  echo "[dk] create-microvm-image (ALL caps)…"
  LM create-microvm-image --name "$IMAGE_NAME" --code-artifact "uri=s3://$S3/$KEY" \
    --base-image-arn "$BASE" --build-role-arn "$ROLE" --additional-os-capabilities '["ALL"]' >/dev/null || { echo "[dk] create failed"; exit 1; }
else
  ARN0=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'].imageArn | [0]" --output text)
  echo "[dk] update-microvm-image (ALL caps)…"
  LM update-microvm-image --image-identifier "$ARN0" --code-artifact "uri=s3://$S3/$KEY" \
    --base-image-arn "$BASE" --build-role-arn "$ROLE" --additional-os-capabilities '["ALL"]' >/dev/null || { echo "[dk] update failed"; exit 1; }
fi
echo -n "[dk] building"
for i in $(seq 1 100); do
  st=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'].state | [0]" --output text 2>/dev/null); echo -n " $st"
  case "$st" in CREATED|UPDATED) echo; break ;; CREATION_FAILED|UPDATE_FAILED) echo; echo "[dk] BUILD FAILED — CloudWatch /aws/lambda/microvms/$IMAGE_NAME"; exit 1 ;; esac
  sleep 15
done
IMAGE_ARN=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'].imageArn | [0]" --output text)
echo "[dk] image=$IMAGE_ARN"

# ---- run one MicroVM (no idle policy) ----
MVM=""
trap 'if [ -n "$MVM" ]; then echo "[dk] terminating $MVM"; LM terminate-microvm --microvm-identifier "$MVM" >/dev/null 2>&1 || true; fi' EXIT INT TERM
RUN=$(LM run-microvm --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$NC:ALL_INGRESS" --egress-network-connectors "$NC:INTERNET_EGRESS" \
  --maximum-duration-in-seconds 3600 2>&1) || { echo "[dk] run-microvm error: $RUN"; exit 1; }
MVM=$(echo "$RUN" | jq -r .microvmId); EP=$(echo "$RUN" | jq -r .endpoint)
echo "[dk] microvm=$MVM ep=$EP"
echo -n "[dk] waiting RUNNING"; for i in $(seq 1 60); do st=$(LM get-microvm --microvm-identifier "$MVM" --query state --output text 2>/dev/null); [ "$st" = RUNNING ] && { echo " RUNNING"; break; }; echo -n " $st"; sleep 5; done

TOK=$(LM create-microvm-auth-token --microvm-identifier "$MVM" --expiration-in-minutes 60 --allowed-ports '[{"allPorts":{}}]' | jq -r '.authToken["X-aws-proxy-auth"] // .authToken')
ENCODED=$("${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runners/generate-jitconfig" \
  -d "{\"name\":\"mayfly-docker-$(date +%s)\",\"runner_group_id\":1,\"labels\":[\"self-hosted\",\"mayfly\"],\"work_folder\":\"_work\"}" | jq -r '.encoded_jit_config // empty')
BR=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO" | jq -r '.default_branch // "main"')
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/dispatches" -d "{\"ref\":\"$BR\"}" -o /dev/null -w "[dk] dispatch %{http_code}\n"
"${CURL[@]}" -X POST "https://$EP/jit" -H "X-aws-proxy-auth: $TOK" -H "X-aws-proxy-port: 8080" -H 'content-type: application/json' -d "{\"jitconfig\":\"$ENCODED\"}" -o /dev/null -w "[dk] jit %{http_code}\n"

RUNID=""; for i in $(seq 1 12); do RUNID=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/runs?event=workflow_dispatch&per_page=10" | jq -r --arg t "$T0" '[.workflow_runs[]|select(.created_at>=$t)]|sort_by(.created_at)|last|.id // empty'); [ -n "$RUNID" ] && break; sleep 5; done
echo "[dk] run=$RUNID  watching…"
concl=""
for i in $(seq 1 40); do concl=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs/$RUNID" | jq -r '"\(.status)/\(.conclusion)"'); echo "  t=$((i*10))s ghrun=$concl"; case "$concl" in completed/*) break ;; esac; sleep 10; done

echo "[dk] --- docker output from the job log ---"
JOB=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs/$RUNID/jobs" | jq -r '.jobs[0].id')
"${CURL[@]}" -L "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/jobs/$JOB/logs" | LC_ALL=C tr -cd '[:print:]\n' \
  | grep -iE 'Docker version|Hello from Docker|built-in-microvm|Successfully built|Successfully tagged|Cannot connect|permission denied|error|arch:' | head -30
echo "[dk] RESULT: $concl  (PASS if completed/success)"
