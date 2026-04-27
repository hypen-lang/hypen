#!/bin/bash

# Open a component/applicator in the HypenGallery app via deep link
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
URL="hypengallery://${NAME}"

echo "🔗 Opening deep link: $URL"
xcrun simctl openurl booted "$URL"

if [ $? -eq 0 ]; then
    echo "✅ Deep link sent to simulator"
else
    echo "❌ Failed to open deep link. Is a simulator running?"
    exit 1
fi
