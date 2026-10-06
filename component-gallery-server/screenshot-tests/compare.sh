#!/bin/bash

# Screenshot Comparison Script
#
# Compares screenshots across iOS, Android, Web, Desktop, and Canvas platforms.
#
# Usage:
#   ./compare.sh [options]
#
# Options:
#   --component=X    Compare only a specific component
#   --threshold=X    Pixel difference threshold 0-1 (default: 0.1)
#   --output=dir     Output directory for diff images
#   --allow-differences  Generate output without failing similarity targets

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Running Screenshot Comparison..."
echo ""

bun run compare-screenshots.ts "$@"
