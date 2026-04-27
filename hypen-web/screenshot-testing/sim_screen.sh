#!/bin/bash

# Take a screenshot of a component in the Hypen Web Gallery using Puppeteer
# Usage: ./sim_screen.sh <component_name> [filename]
# Examples:
#   ./sim_screen.sh button
#   ./sim_screen.sh padding padding_test.png

if [ -z "$1" ]; then
    echo "Usage: ./sim_screen.sh <component_name> [filename]"
    echo ""
    echo "Examples:"
    echo "  ./sim_screen.sh button"
    echo "  ./sim_screen.sh padding padding_test.png"
    exit 1
fi

NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILENAME="${2:-${NAME}_test.png}"

# Ensure .png extension
if [[ "$FILENAME" != *.png ]]; then
    FILENAME="${FILENAME}.png"
fi

OUTPUT_PATH="$SCRIPT_DIR/$FILENAME"
URL="http://localhost:5556?name=${NAME}"

# Phone viewport dimensions (iPhone ratio 1320:2868 ≈ 0.46)
WIDTH="${WIDTH:-430}"
HEIGHT="${HEIGHT:-934}"

echo "Taking screenshot of: $NAME"
echo "URL: $URL"
echo "Viewport: ${WIDTH}x${HEIGHT}"

# Use Puppeteer-based script for proper WebSocket support
cd "$SCRIPT_DIR"
bun run take-screenshot.ts "$URL" "$OUTPUT_PATH" "$WIDTH" "$HEIGHT"

if [ $? -eq 0 ] && [ -s "$OUTPUT_PATH" ]; then
    echo "Done!"
else
    echo "Failed to take screenshot. Is the gallery server running?"
    echo "Start the servers with: cd $SCRIPT_DIR && bun run gallery-server.ts"
    rm -f "$OUTPUT_PATH" 2>/dev/null
    exit 1
fi
