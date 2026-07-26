#!/usr/bin/env bash
# Shim. The real builder is scripts/build-image.ts (`npm run build-image`).
#
# This file used to drive the pipeline with `aws lambda-microvms ...`, which needs a recent
# AWS CLI v2. On an older CLI the service is simply unknown, argparse prints its usage to
# STDOUT, the old script's `>/dev/null` swallowed it, and `set -e` exited — a silent no-op
# that looked like a successful build and left the image untouched. It is kept as a shim
# rather than deleted because INSTALL.md, README.md, the deploy runbook and AWS-LEDGER.md
# all point here.
#
# Env passthrough is unchanged: IMAGE_NAME, BASE_IMAGE_ARN, MAYFLY_REGION. The old
# MAYFLY_HOOKS_ARGS (CLI-flag string) is now MAYFLY_HOOKS (a JSON object).
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${MAYFLY_HOOKS_ARGS:-}" ]; then
  echo "[build] MAYFLY_HOOKS_ARGS is no longer read — pass MAYFLY_HOOKS='{\"port\":8080}' instead." >&2
  exit 1
fi
exec npm run --silent build-image
