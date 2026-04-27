#!/bin/bash

# Take a screenshot from iOS Simulator
# Usage: ./sim_screen.sh [filename]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILENAME="${1:-screenshot_$(date +%Y%m%d_%H%M%S).png}"

# Ensure .png extension
if [[ "$FILENAME" != *.png ]]; then
    FILENAME="${FILENAME}.png"
fi

OUTPUT_PATH="$SCRIPT_DIR/$FILENAME"

echo "📸 Taking screenshot from simulator..."
xcrun simctl io booted screenshot "$OUTPUT_PATH"

if [ $? -eq 0 ]; then
    echo "✅ Screenshot saved to: $OUTPUT_PATH"
else
    echo "❌ Failed to take screenshot. Is a simulator running?"
    exit 1
fi
