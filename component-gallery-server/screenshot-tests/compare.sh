#!/bin/bash

# Screenshot Comparison Script
#
# Compares screenshots across iOS, Android, and Web platforms.
#
# Usage:
#   ./compare.sh [options]
#
# Options:
#   --component=X    Compare only a specific component
#   --threshold=X    Pixel difference threshold 0-1 (default: 0.1)
#   --output=dir     Output directory for diff images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Running Screenshot Comparison..."
echo ""

bun run compare-screenshots.ts "$@"
