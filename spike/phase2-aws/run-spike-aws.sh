#!/usr/bin/env bash
# Phase 2 crux spike (real Lambda MicroVM): does a MicroVM stay RUNNING while the
# runner long-polls and executes one job, handed its JIT config over the real L7
# endpoint (X-aws-proxy-auth)? Answers Unknown #2.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.env
set -a; . ../../.env; set +a   # GITHUB_PAT
: "${AWS_REGION:?}"; : "${GITHUB_PAT:?}"
IMAGE_NAME="${IMAGE_NAME:-mayfly-runner}"
OWNER=mikeng-io; REPO=mayfly-test
GH=https://api.github.com
GA=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }
NC="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector"

IMAGE_ARN=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query imageArn --output text)
echo "[cp] image: $IMAGE_ARN"

# Idle policy tuned so a short job (no INBOUND traffic while the runner long-polls
# OUTBOUND) does not auto-suspend mid-job. This is the crux the docs warn about.
echo "[cp] run-microvm…"
RUN=$(LM run-microvm --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$NC:ALL_INGRESS" \
  --egress-network-connectors "$NC:INTERNET_EGRESS" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":3600,"suspendedDurationSeconds":1800}' \
  --maximum-duration-in-seconds 14400)
MVM=$(echo "$RUN" | jq -r '.microvmId'); EP=$(echo "$RUN" | jq -r '.endpoint')
echo "[cp] microvm=$MVM endpoint=$EP"
trap 'echo "[cp] terminating $MVM…"; LM terminate-microvm --microvm-identifier "$MVM" >/dev/null 2>&1 || true' EXIT

echo -n "[cp] waiting for RUNNING"
for i in $(seq 1 60); do st=$(LM get-microvm --microvm-identifier "$MVM" --query state --output text 2>/dev/null || echo '?'); [ "$st" = RUNNING ] && { echo " …RUNNING"; break; }; echo -n " $st"; sleep 5; done

echo "[cp] minting endpoint auth token…"
TOK=$(LM create-microvm-auth-token --microvm-identifier "$MVM" --expiration-in-minutes 60 --allowed-ports '[{"allPorts":{}}]' \
  | jq -r '.authToken["X-aws-proxy-auth"] // .authToken')
curl -s "https://$EP/health" -H "X-aws-proxy-auth: $TOK" -H "X-aws-proxy-port: 8080" -o /dev/null -w "[cp] endpoint health http:%{http_code}\n"

echo "[cp] minting GitHub JIT config…"
ENCODED=$(curl -s -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runners/generate-jitconfig" \
  -d "{\"name\":\"mayfly-mvm-$(date +%s)\",\"runner_group_id\":1,\"labels\":[\"self-hosted\",\"mayfly\"],\"work_folder\":\"_work\"}" \
  | jq -r '.encoded_jit_config // empty')
[ -z "$ENCODED" ] && { echo "[cp] JIT mint failed"; exit 1; }

DEFAULT_BRANCH=$(curl -s "${GA[@]}" "$GH/repos/$OWNER/$REPO" | jq -r '.default_branch // "main"')
echo "[cp] dispatching workflow…"
curl -s -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/mayfly-spike.yml/dispatches" \
  -d "{\"ref\":\"$DEFAULT_BRANCH\"}" -o /dev/null -w "  dispatch http:%{http_code}\n"

echo "[cp] handing JIT to the MicroVM over its L7 endpoint…"
curl -s -X POST "https://$EP/jit" -H "X-aws-proxy-auth: $TOK" -H "X-aws-proxy-port: 8080" \
  -H 'content-type: application/json' -d "{\"jitconfig\":\"$ENCODED\"}" -o /dev/null -w "  jit http:%{http_code}\n"

echo "[cp] --- watching: MicroVM state vs job progress (the Unknown #2 test) ---"
STAYED_RUNNING=1
for i in $(seq 1 40); do
  st=$(LM get-microvm --microvm-identifier "$MVM" --query state --output text 2>/dev/null || echo '?')
  jl=$(curl -s "https://$EP/status" -H "X-aws-proxy-auth: $TOK" -H "X-aws-proxy-port: 8080" 2>/dev/null | jq -c . 2>/dev/null || echo '{}')
  gh=$(curl -s "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs?per_page=1" | jq -r '.workflow_runs[0] | "\(.status)/\(.conclusion)"')
  printf "  t=%3ds  microvm=%-10s launcher=%-28s ghrun=%s\n" "$((i*10))" "$st" "$jl" "$gh"
  [ "$st" != RUNNING ] && [ "$st" != PENDING ] && STAYED_RUNNING=0
  echo "$jl" | jq -e '.done == true' >/dev/null 2>&1 && { echo "[cp] launcher reports job done"; break; }
  sleep 10
done

echo "[cp] final GitHub run:"
curl -s "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs?per_page=1" | jq -r '.workflow_runs[0] | "  \(.status)/\(.conclusion)  \(.html_url)"'
echo "[cp] microvm stayed RUNNING throughout: $([ $STAYED_RUNNING = 1 ] && echo YES || echo NO)"
echo "[cp] PASS = stayed RUNNING + ghrun success. (MicroVM will be terminated on exit.)"
