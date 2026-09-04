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
#   --canvas-only   Run only Canvas renderer tests
#   --desktop-only  Run only Desktop renderer tests
#   --skip-ios      Skip iOS tests
#   --skip-android  Skip Android tests
#   --skip-web      Skip Web tests
#   --skip-canvas   Skip Canvas renderer tests
#   --skip-desktop  Skip Desktop renderer tests
#   --component=X   Test only a specific component/applicator
#   --skip-install  Skip app installation
#   --skip-server   Skip starting the component server
#   --resume        Resume from last run (skip already-completed tests)
#   --fresh         Delete progress file before running (force re-run)
#   --ios-simulator=X / --ios-udid=X       Pin the iOS simulator
#   --ios-width=X / --ios-height=X         Expected iOS screenshot size
#   --android-avd=X / --android-serial=X   Pin the Android emulator
#   --android-api=X                        Expected Android API level
#   --android-width=X / --android-height=X Expected Android screenshot size
#   --android-density=X                    Expected Android density dpi

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "Running Hypen Screenshot Tests..."
echo ""

bun run run-tests.ts "$@"
