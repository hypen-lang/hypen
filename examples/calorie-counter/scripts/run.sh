#!/usr/bin/env bash
# Thin wrapper around the generic runner at `examples/scripts/run.sh`.
# The calorie-counter example currently ships a TypeScript server only,
# so `ts` is the practical language argument — other branches (go,
# rust, kotlin, swift) exist in the generic script but will fail
# fast here with "no such directory" because we don't ship those.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../../scripts/run.sh" --example calorie-counter "$@"
