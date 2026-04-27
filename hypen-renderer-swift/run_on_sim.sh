#!/bin/bash
#
# Build, install, and launch HypenGallery on an iOS Simulator.
#
# Usage:
#   ./run_on_sim.sh [--url ws://host:port] [--tail] [--clean]
#
# Options:
#   --url <url>      After launch, deep-link the app to a Hypen dev server.
#                    Accepts either a ws:// URL (wrapped automatically into
#                    hypenpreview://connect?url=...) or a full hypenpreview://
#                    deep link. Example: --url ws://localhost:3000
#   --tail           Stream the app's stdout after launch (blocking). Default
#                    is non-blocking — the script exits once the app is up.
#   --clean          Wipe DerivedData before building.
#
# Exit codes:
#   0  success
#   1  no suitable simulator
#   2  build failure
#   3  install failure
#   4  launch failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/Gallery/HypenGallery"
XCODEPROJ="$PROJECT_DIR/HypenGallery.xcodeproj"
SCHEME="HypenGallery"
BUNDLE_ID="space.hypen.gallery.HypenGallery"
DERIVED_DATA="$PROJECT_DIR/DerivedData"

# --- Parse args ---
DEEP_LINK_URL=""
TAIL_LOGS=false
CLEAN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --url)
            DEEP_LINK_URL="${2:-}"
            shift 2
            ;;
        --tail)
            TAIL_LOGS=true
            shift
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        -h|--help)
            sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

# --- Find a simulator ---
SIMULATOR_ID="$(xcrun simctl list devices available | grep 'Booted' | head -1 | grep -oE '[A-F0-9-]{36}' || true)"

if [ -z "$SIMULATOR_ID" ]; then
    echo "No booted simulator, falling back to iPhone 16 Pro Max..."
    SIMULATOR_ID="$(xcrun simctl list devices available | grep 'iPhone 16 Pro Max' | grep -oE '[A-F0-9-]{36}' | head -1 || true)"
fi

if [ -z "$SIMULATOR_ID" ]; then
    echo "No suitable simulator found. Boot one with:" >&2
    echo "  open -a Simulator" >&2
    exit 1
fi

SIMULATOR_NAME="$(xcrun simctl list devices | grep "$SIMULATOR_ID" | sed 's/(.*//' | xargs)"
echo "Using simulator: $SIMULATOR_NAME ($SIMULATOR_ID)"

# --- Normalize deep-link URL ---
# Accept bare ws://host:port and wrap into hypenpreview://connect?url=<encoded>.
# Pass through hypenpreview:// URLs unchanged.
if [ -n "$DEEP_LINK_URL" ]; then
    case "$DEEP_LINK_URL" in
        hypenpreview://*)
            ;;
        ws://*|wss://*|http://*|https://*)
            # urlencode the connection URL — enough coverage for ws URLs.
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

# --- Boot if needed ---
BOOT_STATE="$(xcrun simctl list devices | grep "$SIMULATOR_ID" | grep -oE '\((Booted|Shutdown|Booting)\)' | tr -d '()' || echo Shutdown)"
if [ "$BOOT_STATE" != "Booted" ]; then
    echo "Booting simulator..."
    xcrun simctl boot "$SIMULATOR_ID"
    xcrun simctl bootstatus "$SIMULATOR_ID" -b
fi

# --- Clean ---
if [ "$CLEAN" = true ]; then
    echo "Wiping DerivedData..."
    rm -rf "$DERIVED_DATA"
fi

# --- Build ---
echo "Building $SCHEME..."
BUILD_LOG="$(mktemp -t hypen-gallery-build.XXXXXX)"
trap 'rm -f "$BUILD_LOG"' EXIT

set +e
xcodebuild \
    -project "$XCODEPROJ" \
    -scheme "$SCHEME" \
    -destination "id=$SIMULATOR_ID" \
    -derivedDataPath "$DERIVED_DATA" \
    -quiet \
    CODE_SIGNING_ALLOWED=NO \
    build \
    > "$BUILD_LOG" 2>&1
BUILD_STATUS=$?
set -e

if [ $BUILD_STATUS -ne 0 ]; then
    echo "Build failed (exit $BUILD_STATUS). xcodebuild output:" >&2
    echo "---" >&2
    # Prefer diagnostic lines; if none matched, dump the whole log so we never
    # swallow a real failure.
    if grep -E '(error:|warning:|ld: |undefined symbol|note:)' "$BUILD_LOG" >&2; then
        :
    else
        tail -200 "$BUILD_LOG" >&2
    fi
    echo "---" >&2
    echo "Full log: $BUILD_LOG" >&2
    trap - EXIT
    exit 2
fi

echo "Build succeeded."

# --- Find built .app ---
APP_PATH="$(find "$DERIVED_DATA" -type d -name 'HypenGallery.app' -path '*Debug-iphonesimulator*' 2>/dev/null | head -1)"
if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    echo "Could not locate built HypenGallery.app under $DERIVED_DATA" >&2
    exit 2
fi
echo "Built app: $APP_PATH"

# --- Install (terminate first so we don't race an older copy) ---
echo "Installing..."
xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
if ! xcrun simctl install "$SIMULATOR_ID" "$APP_PATH"; then
    echo "Install failed." >&2
    exit 3
fi

# --- Launch ---
echo "Launching..."
if [ "$TAIL_LOGS" = true ]; then
    # Blocking: stream app stdout until the app exits. Deep-link before we
    # block, otherwise the URL would never be opened.
    if [ -n "$DEEP_LINK_URL" ]; then
        # Launch in the background, open URL, then attach a fresh console tail.
        xcrun simctl launch "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null
        sleep 0.3
        xcrun simctl openurl "$SIMULATOR_ID" "$DEEP_LINK_URL"
        echo "Tailing app logs (Ctrl-C to detach)..."
        # spawn-and-tail via a dummy relaunch with --console-pty
        xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
        exec xcrun simctl launch --console-pty "$SIMULATOR_ID" "$BUNDLE_ID"
    else
        exec xcrun simctl launch --console-pty "$SIMULATOR_ID" "$BUNDLE_ID"
    fi
else
    if ! xcrun simctl launch "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null; then
        echo "Launch failed." >&2
        exit 4
    fi
    if [ -n "$DEEP_LINK_URL" ]; then
        sleep 0.3
        echo "Opening deep link: $DEEP_LINK_URL"
        xcrun simctl openurl "$SIMULATOR_ID" "$DEEP_LINK_URL"
    fi
    echo "HypenGallery is running on $SIMULATOR_NAME."
fi
