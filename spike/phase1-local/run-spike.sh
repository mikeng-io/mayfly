#!/usr/bin/env bash
# Phase 1 crux spike (local, no AWS): prove the in-VM launcher receives a JIT
# config over HTTP and runs one real GitHub Actions job to clean exit.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
set -a; . "$ROOT/.env"; set +a
: "${GITHUB_PAT:?need GITHUB_PAT in .env}"

OWNER=mikeng-io; REPO=mayfly-test
API=https://api.github.com
AUTH=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
LABELS='["self-hosted","mayfly"]'
IMG=mayfly-runner:spike; CTR=mayfly-spike; HOST_PORT=18080

case "$(uname -m)" in
  arm64|aarch64) RUNNER_ARCH=arm64 ;;
  x86_64|amd64)  RUNNER_ARCH=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac
RUNNER_VERSION=$(curl -s "${AUTH[@]}" "$API/repos/actions/runner/releases/latest" | jq -r '.tag_name' | sed 's/^v//')
echo "[cp] runner v$RUNNER_VERSION arch=$RUNNER_ARCH"

echo "[cp] building image (first build downloads the runner; a few min)…"
docker build --build-arg RUNNER_VERSION="$RUNNER_VERSION" --build-arg RUNNER_ARCH="$RUNNER_ARCH" -t "$IMG" .

DEFAULT_BRANCH=$(curl -s "${AUTH[@]}" "$API/repos/$OWNER/$REPO" | jq -r '.default_branch // "main"')

NAME="mayfly-spike-$(date +%s)"
echo "[cp] minting JIT config (runner=$NAME)…"
JIT=$(curl -s -X POST "${AUTH[@]}" "$API/repos/$OWNER/$REPO/actions/runners/generate-jitconfig" \
  -d "{\"name\":\"$NAME\",\"runner_group_id\":1,\"labels\":$LABELS,\"work_folder\":\"_work\"}")
ENCODED=$(echo "$JIT" | jq -r '.encoded_jit_config // empty')
if [ -z "$ENCODED" ]; then echo "[cp] JIT mint FAILED:"; echo "$JIT" | jq .; exit 1; fi
echo "[cp] JIT config minted"

docker rm -f "$CTR" >/dev/null 2>&1 || true
docker run -d --name "$CTR" -p "$HOST_PORT":8080 "$IMG" >/dev/null
echo -n "[cp] waiting for launcher health"
for i in $(seq 1 30); do curl -sf "localhost:$HOST_PORT/health" >/dev/null 2>&1 && { echo " …ok"; break; }; echo -n "."; sleep 1; done

echo "[cp] dispatching workflow…"
curl -s -X POST "${AUTH[@]}" "$API/repos/$OWNER/$REPO/actions/workflows/mayfly-spike.yml/dispatches" \
  -d "{\"ref\":\"$DEFAULT_BRANCH\"}" -o /dev/null -w "  dispatch http:%{http_code}\n"

echo "[cp] handing JIT to in-VM launcher…"
curl -s -X POST "localhost:$HOST_PORT/run" -H 'content-type: application/json' \
  -d "{\"jitconfig\":\"$ENCODED\"}" -o /dev/null -w "  launcher http:%{http_code}\n"

echo "[cp] --- runner logs (container exits when the one job finishes) ---"
timeout 300 docker logs -f "$CTR" || true
CODE=$(docker inspect -f '{{.State.ExitCode}}' "$CTR" 2>/dev/null || echo '?')
echo "[cp] --- container exit code: $CODE ---"

sleep 3
echo "[cp] latest workflow run:"
curl -s "${AUTH[@]}" "$API/repos/$OWNER/$REPO/actions/runs?per_page=1" \
  | jq -r '.workflow_runs[0] | "  status=\(.status) conclusion=\(.conclusion)\n  \(.html_url)"'
echo "[cp] PASS = container exit 0 + conclusion success + runner auto-deregistered (ephemeral, single-use)."
