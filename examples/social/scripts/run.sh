#!/usr/bin/env bash
# Thin wrapper around the generic runner at `examples/scripts/run.sh`.
# Kept so existing `./scripts/run.sh ts ios` invocations from the
# social/ directory keep working; the real logic lives one directory
# up and is shared with calorie-counter (and any future example).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../../scripts/run.sh" --example social "$@"
