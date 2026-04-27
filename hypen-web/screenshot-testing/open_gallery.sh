#!/bin/bash

# Open a component/applicator in the Hypen Web Gallery at phone viewport size
# Usage: ./open_gallery.sh <name>
# Examples:
#   ./open_gallery.sh column
#   ./open_gallery.sh padding
#   ./open_gallery.sh Button

if [ -z "$1" ]; then
    echo "Usage: ./open_gallery.sh <component_or_applicator_name>"
    echo ""
    echo "Components:"
    echo "  column, row, text, button, image, container, center, list, input,"
    echo "  link, textarea, checkbox, select, spacer, stack, divider, grid,"
    echo "  card, heading, switch, slider, spinner, badge, avatar, progressbar,"
    echo "  video, audio, paragraph"
    echo ""
    echo "Applicators:"
    echo "  padding, margin, color, backgroundColor, opacity, width, height,"
    echo "  size, fillMaxSize, border, borderRadius, cornerRadius, fontSize,"
    echo "  fontWeight, fontFamily, textAlign, lineHeight, gap, weight, flex,"
    echo "  verticalAlignment, horizontalAlignment, shadow, elevation, blur, transform,"
    echo "  rotate, scale, transition, overflow, zIndex, position, gridColumns,"
    echo "  linearGradient, maxLines"
    exit 1
fi

NAME="$1"
URL="http://localhost:5556?name=${NAME}"

# Phone viewport dimensions (iPhone ratio 1320:2868 ≈ 0.46)
WIDTH="${2:-430}"
HEIGHT="${3:-934}"

echo "Opening: $URL"
echo "Viewport: ${WIDTH}x${HEIGHT}"

# Detect Chrome/Chromium path
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
    CHROME="/Applications/Chromium.app/Contents/MacOS/Chromium"
elif command -v google-chrome &> /dev/null; then
    CHROME="google-chrome"
elif command -v chromium &> /dev/null; then
    CHROME="chromium"
elif command -v chromium-browser &> /dev/null; then
    CHROME="chromium-browser"
else
    echo "Chrome/Chromium not found. Opening with default browser..."
    open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null
    exit 0
fi

# Open Chrome with specific window size
"$CHROME" \
    --new-window \
    --window-size=${WIDTH},${HEIGHT} \
    --window-position=100,100 \
    --app="$URL" \
    2>/dev/null &

if [ $? -eq 0 ]; then
    echo "Browser opened successfully"
else
    echo "Failed to open browser"
    exit 1
fi
