#!/bin/bash

# Take a screenshot from Android Emulator/Device
# Usage: ./sim_screen.sh [filename]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILENAME="${1:-screenshot_$(date +%Y%m%d_%H%M%S).png}"

# Ensure .png extension
if [[ "$FILENAME" != *.png ]]; then
    FILENAME="${FILENAME}.png"
fi

OUTPUT_PATH="$SCRIPT_DIR/$FILENAME"

echo "Taking screenshot from device/emulator..."
adb exec-out screencap -p > "$OUTPUT_PATH"

if [ $? -eq 0 ] && [ -s "$OUTPUT_PATH" ]; then
    echo "Screenshot saved to: $OUTPUT_PATH"
else
    echo "Failed to take screenshot. Is an emulator running or device connected?"
    rm -f "$OUTPUT_PATH"
    exit 1
fi
