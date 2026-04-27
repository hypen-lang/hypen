#!/bin/bash
#
# Build, install, and launch HypenGallery on an Android emulator or device.
#
# Usage:
#   ./run_on_sim.sh [--url ws://host:port] [--clean]
#
# Options:
#   --url <url>      After launch, deep-link the app to a Hypen dev server.
#                    Accepts either a ws:// URL (wrapped automatically into
#                    hypenpreview://connect?url=...) or a full hypenpreview://
#                    deep link. Note: Android emulators reach the host machine
#                    via 10.0.2.2, not localhost. Example:
#                      --url ws://10.0.2.2:3000
#   --clean          Run `./gradlew clean` before building.
#
# Exit codes:
#   0  success
#   1  no device/emulator or env problem
#   2  build/install failure

#   3  launch failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ID="space.hypen.gallery"
MAIN_ACTIVITY="$PACKAGE_ID/.MainActivity"

# --- Parse args ---
DEEP_LINK_URL=""
CLEAN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --url)
            DEEP_LINK_URL="${2:-}"
            shift 2
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        -h|--help)
            sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

# --- Check adb is available ---
if ! command -v adb >/dev/null 2>&1; then
    echo "adb not found on PATH. Install Android SDK platform-tools:" >&2
    echo "  brew install --cask android-platform-tools" >&2
    exit 1
fi

# --- Check a device/emulator is attached ---
DEVICE_COUNT="$(adb devices | awk 'NR>1 && $2=="device" {c++} END {print c+0}')"
if [ "$DEVICE_COUNT" -eq 0 ]; then
    echo "No Android device or emulator found. Start one with:" >&2
    echo "  emulator -list-avds       # list available" >&2
    echo "  emulator -avd <name> &    # boot one" >&2
    exit 1
fi

DEVICE_NAME="$(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r' || echo 'unknown device')"
echo "Using device: $DEVICE_NAME"

# --- Normalize deep-link URL ---
# Accept bare ws://host:port and wrap into hypenpreview://connect?url=<encoded>.
# Pass through hypenpreview:// URLs unchanged.
if [ -n "$DEEP_LINK_URL" ]; then
    case "$DEEP_LINK_URL" in
        hypenpreview://*)
            ;;
        ws://*|wss://*|http://*|https://*)
            encoded="$DEEP_LINK_URL"
            encoded="${encoded//%/%25}"
            encoded="${encoded//:/%3A}"
            encoded="${encoded//\//%2F}"
            encoded="${encoded//\?/%3F}"
            encoded="${encoded//&/%26}"
            encoded="${encoded//=/%3D}"
            DEEP_LINK_URL="hypenpreview://connect?url=$encoded"
            ;;
        *)
            echo "Unrecognized --url scheme: $DEEP_LINK_URL" >&2
            echo "Expected ws://, wss://, http://, https://, or hypenpreview://" >&2
            exit 1
            ;;
    esac
fi

cd "$SCRIPT_DIR"

# --- Clean ---
if [ "$CLEAN" = true ]; then
    echo "Running ./gradlew clean..."
    ./gradlew clean
fi

# --- Build & install ---
echo "Building and installing HypenGallery..."
BUILD_LOG="$(mktemp -t hypen-android-build.XXXXXX)"
trap 'rm -f "$BUILD_LOG"' EXIT

set +e
./gradlew :app:installDebug --console=plain > "$BUILD_LOG" 2>&1
BUILD_STATUS=$?
set -e

if [ $BUILD_STATUS -ne 0 ]; then
    echo "Build/install failed (exit $BUILD_STATUS). Gradle output:" >&2
    echo "---" >&2
    # Show the failure block; fall back to the tail so nothing is ever fully swallowed.
    if grep -nE '(FAILED|error:|e: |Exception|Caused by)' "$BUILD_LOG" >&2; then
        :
    else
        tail -200 "$BUILD_LOG" >&2
    fi
    echo "---" >&2
    echo "Full log: $BUILD_LOG" >&2
    trap - EXIT
    exit 2
fi

echo "Build and install succeeded."

# --- Launch ---
if [ -n "$DEEP_LINK_URL" ]; then
    # Use VIEW intent with the deep link — the manifest registers the
    # hypenpreview:// scheme on MainActivity, so this both launches the app
    # and opens the connect URL in one shot.
    echo "Launching via deep link: $DEEP_LINK_URL"
    if ! adb shell am start -a android.intent.action.VIEW -d "\"$DEEP_LINK_URL\"" >/dev/null; then
        echo "Launch (deep link) failed." >&2
        exit 3
    fi
else
    echo "Launching..."
    if ! adb shell am start -n "$MAIN_ACTIVITY" >/dev/null; then
        echo "Launch failed." >&2
        exit 3
    fi
fi

echo "HypenGallery is running on $DEVICE_NAME."
