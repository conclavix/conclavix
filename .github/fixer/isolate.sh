#!/usr/bin/env bash
# Usage: isolate.sh <command> [args...]
# Runs the command in its own PID namespace (bubblewrap): every process it starts is killed when it
# ends, so no process of a PR-code step outlives the step. Without bwrap the command runs as is.
set -euo pipefail
if command -v bwrap > /dev/null 2>&1; then
  exec bwrap --dev-bind / / --proc /proc --unshare-pid --die-with-parent -- "$@"
fi
echo "isolate.sh: bwrap is not installed, running without a PID namespace" >&2
exec "$@"
