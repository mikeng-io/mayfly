#!/usr/bin/env bash
# Phase 2 crux spike (real Lambda MicroVM) — Unknown #2.
#
# Observes MicroVM state via the CONTROL PLANE only (get-microvm) — NEVER the
# endpoint during the idle window, because endpoint traffic resets the idle
# timer / auto-resumes, which is the exact hazard under test (review S1).
#
# Two experiments (review S2):
#   HAZARD: short idle policy + a job longer than idle -> expect SUSPEND mid-job.
#   SAFE:   no idle policy (auto-suspend off) + same job -> expect STAY RUNNING + success.
#
# The only endpoint traffic is the one-time JIT hand-off (unavoidable — that's
# how the config gets in). After that, observation is control-plane only.
set -uo pipefail
cd "$(dirname "$0")"; source ./config.env
set -a; . ../../.env; set +a
: "${AWS_REGION:?}"; : "${GITHUB_PAT:?}"
IMAGE_NAME="${IMAGE_NAME:-mayfly-runner}"
OWNER=mikeng-io; REPO=mayfly-test; WF=mayfly-spike.yml
JOB_SLEEP="${JOB_SLEEP:-120}"          # job sleeps this long
HAZARD_IDLE="${HAZARD_IDLE:-45}"       # hazard idle window (< JOB_SLEEP so it can suspend mid-job)
GH=https://api.github.com
GA=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
LM(){ aws lambda-microvms "$@" --region "$AWS_REGION"; }
NC="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector"
CURL=(curl -s --connect-timeout 10 --max-time 30)

[ "$HAZARD_IDLE" -lt "$JOB_SLEEP" ] || { echo "HAZARD_IDLE must be < JOB_SLEEP to test suspend-mid-job"; exit 1; }

IMAGE_ARN=$(LM get-microvm-image --image-identifier "$IMAGE_NAME" --query imageArn --output text 2>/dev/null) \
  || { echo "[cp] no image '$IMAGE_NAME' — run ./build-image.sh first"; exit 1; }
echo "[cp] image: $IMAGE_ARN   job_sleep=${JOB_SLEEP}s  hazard_idle=${HAZARD_IDLE}s"

CUR_MVM=""
cleanup(){ if [ -n "$CUR_MVM" ]; then echo "[cp] terminating $CUR_MVM…"; LM terminate-microvm --microvm-identifier "$CUR_MVM" >/dev/null 2>&1 || true; CUR_MVM=""; fi; }
trap cleanup EXIT INT TERM

HAZARD_RESULT=""; SAFE_RESULT=""

run_one(){  # $1=label  $2=idle-policy-json(empty=off)  -> sets <LABEL>_RESULT
  local label="$1" idle="$2"
  echo; echo "==================== RUN: $label ===================="
  echo "[cp] idle-policy: ${idle:-<none — auto-suspend OFF>}"
  local args=(run-microvm --image-identifier "$IMAGE_ARN"
    --ingress-network-connectors "$NC:ALL_INGRESS" --egress-network-connectors "$NC:INTERNET_EGRESS"
    --maximum-duration-in-seconds 14400)
  [ -n "$idle" ] && args+=(--idle-policy "$idle")

  local run mvm ep
  run=$(LM "${args[@]}" 2>&1) || { echo "[cp] run-microvm error: $run"; eval "${label}_RESULT='FAIL(run-microvm)'"; return; }
  mvm=$(echo "$run" | jq -r '.microvmId'); ep=$(echo "$run" | jq -r '.endpoint')
  CUR_MVM="$mvm"; echo "[cp] microvm=$mvm endpoint=$ep"

  local st reached=0
  echo -n "[cp] waiting RUNNING"
  for i in $(seq 1 60); do st=$(LM get-microvm --microvm-identifier "$mvm" --query state --output text 2>/dev/null || echo '?'); [ "$st" = RUNNING ] && { echo " …RUNNING"; reached=1; break; }; echo -n " $st"; sleep 5; done
  [ "$reached" = 1 ] || { echo "[cp] never reached RUNNING"; cleanup; eval "${label}_RESULT='FAIL(never RUNNING)'"; return; }

  local tok
  tok=$(LM create-microvm-auth-token --microvm-identifier "$mvm" --expiration-in-minutes 60 --allowed-ports '[{"allPorts":{}}]' 2>/dev/null | jq -r '.authToken["X-aws-proxy-auth"] // .authToken')
  "${CURL[@]}" "https://$ep/health" -H "X-aws-proxy-auth: $tok" -H "X-aws-proxy-port: 8080" -o /dev/null -w "[cp] endpoint health http:%{http_code}\n" || true

  local encoded default_branch t0 runid
  encoded=$("${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runners/generate-jitconfig" \
    -d "{\"name\":\"mayfly-$label-$(date +%s)\",\"runner_group_id\":1,\"labels\":[\"self-hosted\",\"mayfly\"],\"work_folder\":\"_work\"}" | jq -r '.encoded_jit_config // empty')
  [ -z "$encoded" ] && { echo "[cp] JIT mint failed"; cleanup; eval "${label}_RESULT='FAIL(jit)'"; return; }
  default_branch=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO" | jq -r '.default_branch // "main"')

  t0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[cp] dispatching workflow (sleep=${JOB_SLEEP}s)…"
  "${CURL[@]}" -X POST "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/dispatches" \
    -d "{\"ref\":\"$default_branch\",\"inputs\":{\"sleep\":\"$JOB_SLEEP\"}}" -o /dev/null -w "  dispatch http:%{http_code}\n"

  echo "[cp] handing JIT over the L7 endpoint (the ONLY endpoint traffic)…"
  "${CURL[@]}" -X POST "https://$ep/jit" -H "X-aws-proxy-auth: $tok" -H "X-aws-proxy-port: 8080" \
    -H 'content-type: application/json' -d "{\"jitconfig\":\"$encoded\"}" -o /dev/null -w "  jit http:%{http_code}\n"

  # correlate the exact run we dispatched (review S7)
  echo -n "[cp] locating our workflow run"
  for i in $(seq 1 12); do
    runid=$("${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/workflows/$WF/runs?event=workflow_dispatch&per_page=10" \
      | jq -r --arg t "$t0" '[.workflow_runs[]|select(.created_at>=$t)]|sort_by(.created_at)|last|.id // empty')
    [ -n "$runid" ] && { echo " …run=$runid"; break; }; echo -n "."; sleep 5
  done

  # watch via CONTROL PLANE ONLY (no endpoint traffic)
  echo "[cp] --- watching (control-plane get-microvm only) ---"
  local suspended=0 concl='' state=''
  for i in $(seq 1 40); do
    state=$(LM get-microvm --microvm-identifier "$mvm" --query state --output text 2>/dev/null || echo '?')
    concl=$([ -n "$runid" ] && "${CURL[@]}" "${GA[@]}" "$GH/repos/$OWNER/$REPO/actions/runs/$runid" | jq -r '"\(.status)/\(.conclusion)"' || echo '?/?')
    printf "  t=%3ds  microvm=%-11s ghrun=%s\n" "$((i*10))" "$state" "$concl"
    case "$state" in SUSPENDING|SUSPENDED) suspended=1; echo "[cp] MicroVM SUSPENDED mid-job"; break ;; esac
    case "$concl" in completed/success|completed/failure|completed/cancelled) break ;; esac
    sleep 10
  done

  echo "[cp] terminating $mvm…"; LM terminate-microvm --microvm-identifier "$mvm" >/dev/null 2>&1 || true; CUR_MVM=""

  # verdict per experiment
  if [ "$label" = HAZARD ]; then
    if [ "$suspended" = 1 ]; then eval "${label}_RESULT='SUSPENDED mid-job (hazard confirmed real)'"; else eval "${label}_RESULT=\"did NOT suspend (state=$state, ghrun=$concl)\""; fi
  else
    if [ "$suspended" = 1 ]; then eval "${label}_RESULT='FAIL — suspended even with auto-suspend off'";
    elif [ "$concl" = completed/success ]; then eval "${label}_RESULT='PASS — stayed RUNNING, job success'";
    else eval "${label}_RESULT=\"INCONCLUSIVE (state=$state, ghrun=$concl)\""; fi
  fi
}

run_one HAZARD "{\"autoResumeEnabled\":true,\"maxIdleDurationSeconds\":$HAZARD_IDLE,\"suspendedDurationSeconds\":1800}"
run_one SAFE   ""

echo; echo "==================== RESULT ===================="
echo "  HAZARD (short idle, long job): $HAZARD_RESULT"
echo "  SAFE   (auto-suspend off):     $SAFE_RESULT"
case "$SAFE_RESULT" in PASS*) echo "[cp] Unknown #2: RESOLVED — design config (auto-suspend off during a job) holds."; exit 0 ;; *) echo "[cp] Unknown #2: NOT cleanly resolved — see SAFE result."; exit 1 ;; esac
