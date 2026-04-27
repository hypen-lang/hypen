#!/bin/bash

# Hypen Component Gallery Screenshot Tests
#
# Usage:
#   ./run-tests.sh [options]
#
# Options:
#   --ios-only      Run only iOS tests
#   --android-only  Run only Android tests
#   --web-only      Run only Web tests
#   --skip-ios      Skip iOS tests
#   --skip-android  Skip Android tests
#   --skip-web      Skip Web tests
#   --component=X   Test only a specific component/applicator
#   --skip-install  Skip app installation
#   --skip-server   Skip starting the component server
#   --resume        Resume from last run (skip already-completed tests)
#   --fresh         Delete progress file before running (force re-run)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "Running Hypen Screenshot Tests..."
echo ""

bun run run-tests.ts "$@"
