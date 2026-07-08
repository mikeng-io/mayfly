#!/usr/bin/env bash
# One-time: upload the spike workflow to the test repo's default branch.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
set -a; . "$ROOT/.env"; set +a
: "${GITHUB_PAT:?need GITHUB_PAT in .env}"

OWNER=mikeng-io; REPO=mayfly-test
API=https://api.github.com
AUTH=(-H "Authorization: Bearer $GITHUB_PAT" -H "X-GitHub-Api-Version: 2022-11-28")
WF_PATH=".github/workflows/mayfly-spike.yml"

CONTENT=$(base64 < workflows/mayfly-spike.yml | tr -d '\n')
SHA=$(curl -s "${AUTH[@]}" "$API/repos/$OWNER/$REPO/contents/$WF_PATH" | jq -r '.sha // empty')

BODY=$(jq -n --arg m "add mayfly spike workflow" --arg c "$CONTENT" --arg s "$SHA" \
  'if $s == "" then {message:$m, content:$c} else {message:$m, content:$c, sha:$s} end')

RESP=$(curl -s -X PUT "${AUTH[@]}" "$API/repos/$OWNER/$REPO/contents/$WF_PATH" -d "$BODY")
if echo "$RESP" | jq -e '.content.sha' >/dev/null 2>&1; then
  echo "[setup] workflow uploaded to $WF_PATH"
else
  echo "[setup] upload FAILED:"; echo "$RESP" | jq .; exit 1
fi
