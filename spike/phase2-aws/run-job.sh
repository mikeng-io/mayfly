#!/usr/bin/env bash
# Generic single-job runner: run ONE MicroVM from an existing image, hand it the
# JIT for a given workflow, watch to completion, print the job log, terminate.
# Usage: ./run-job.sh <IMAGE_NAME> <WORKFLOW_FILE> [grep-regex]
set -o pipefail
cd "$(dirname "$0")"
set -a; . ../../.env; set +a
source ./config.env 2>/dev/null || true
export AWS_PAGER=""
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
IMAGE_NAME="${1:?usage: run-job.sh <IMAGE_NAME> <WORKFLOW_FILE> [grep]}"
WF="${2:?workflow file, e.g. mayfly-astro.yml}"
GREP="${3:-error|fail|warn|OK|built|arch|Cannot find|npm|node}"
OWNER=mikeng-io; REPO=mayfly-test
GH=https://api.github.com
GA=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
CURL=(curl -s --connect-timeout 10 --max-time 60)
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }
NC="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector"

IMAGE_ARN=$(LM list-microvm-images --query "items[?name=='$IMAGE_NAME'].imageArn | [0]" --output text 2>/dev/null)
[ -n "$IMAGE_ARN" ] && [ "$IMAGE_ARN" != None ] || { echo "no image '$IMAGE_NAME'"; exit 1; }
echo "[job] image=$IMAGE_ARN workflow=$WF"

MVM=""
trap 'if [ -n "$MVM" ]; then echo "[job] terminating $MVM"; LM terminate-microvm --microvm-identifier "$MVM" >/dev/null 2>&1 || true; fi' EXIT INT TERM
RUN=$(LM run-microvm --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$NC:ALL_INGRESS" --egress-network-connectors "$NC:INTERNET_EGRESS" \
  --maximum-duration-in-seconds 3600 2>&1) || { echo "[job] run error: $RUN"; exit 1; }
MVM=$(echo "$RUN" | jq -r .microvmId); EP=$(echo "$RUN" | jq -r .endpoint)
echo "[job] microvm=$MVM"
echo -n "[job] waiting RUNNING"; for i in $(seq 1 60); do st=$(LM get-microvm --microvm-identifier "$MVM" --query state --output text 2>/dev/null); [ "$st" = RUNNING ] && { echo " RUNNING"; break; }; echo -n " $st"; sleep 5; done

TOK=$(LM create-microvm-auth-token --microvm-identifier "$MVM" --expiration-in-minutes 60 --allowed-ports '[{"allPorts":{}}]' | jq -r '.authToken["X-aws-proxy-auth"] // .authToken')
ENCODED=$("${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runners/generate-jitconfig" \
  -d "{\"name\":\"mayfly-job-$(date +%s)\",\"runner_group_id\":1,\"labels\":[\"self-hosted\",\"mayfly\"],\"work_folder\":\"_work\"}" | jq -r '.encoded_jit_config // empty')
BR=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO" | jq -r '.default_branch // "main"')
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/dispatches" -d "{\"ref\":\"$BR\"}" -o /dev/null -w "[job] dispatch %{http_code}\n"
"${CURL[@]}" -X POST "https://$EP/jit" -H "X-aws-proxy-auth: $TOK" -H "X-aws-proxy-port: 8080" -H 'content-type: application/json' -d "{\"jitconfig\":\"$ENCODED\"}" -o /dev/null -w "[job] jit %{http_code}\n"

RUNID=""; for i in $(seq 1 12); do RUNID=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/runs?event=workflow_dispatch&per_page=10" | jq -r --arg t "$T0" '[.workflow_runs[]|select(.created_at>=$t)]|sort_by(.created_at)|last|.id // empty'); [ -n "$RUNID" ] && break; sleep 5; done
echo "[job] run=$RUNID watching…"; concl=""
for i in $(seq 1 60); do concl=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs/$RUNID" | jq -r '"\(.status)/\(.conclusion)"'); echo "  t=$((i*10))s ghrun=$concl"; case "$concl" in completed/*) break ;; esac; sleep 10; done

echo "[job] --- log (filtered) ---"
JOB=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs/$RUNID/jobs" | jq -r '.jobs[0].id')
"${CURL[@]}" -L "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/jobs/$JOB/logs" | LC_ALL=C tr -cd '[:print:]\n' | grep -iE "$GREP" | tail -40
echo "[job] RESULT: $concl"
