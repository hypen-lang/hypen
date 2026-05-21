#!/usr/bin/env bash
# Generic per-example runner. Originally lived under
# `examples/social/scripts/run.sh`; pulled up to `examples/scripts/`
# so the calorie-counter (and any future example) can reuse it
# without copy-paste. Each example keeps a thin shim under its own
# `scripts/run.sh` that just `exec`s this one with `--example <name>`,
# so muscle-memory calls like `./scripts/run.sh ts ios` keep working.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXAMPLES_DIR="$(dirname "$SCRIPT_DIR")"
CLI_DIR="$EXAMPLES_DIR/../hypen-cli"

# Parse the example selector first, then leave the rest of the args
# untouched for the original positional-arg parsing below.
EXAMPLE_NAME="social"
PASSTHROUGH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --example)
      shift
      if [ $# -eq 0 ]; then
        echo "Error: --example requires a value (e.g. social, calorie-counter)" >&2
        exit 1
      fi
      EXAMPLE_NAME="$1"
      shift
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}"

# `SOCIAL_DIR` is the legacy name kept for grep-locatability in the
# body below — it always points at the *currently selected* example.
SOCIAL_DIR="$EXAMPLES_DIR/$EXAMPLE_NAME"
if [ ! -d "$SOCIAL_DIR" ]; then
  echo "Error: --example $EXAMPLE_NAME → no such directory $SOCIAL_DIR" >&2
  exit 1
fi
# Slugified name for the Go `-o` binary (only example-specific token).
EXAMPLE_BIN="${EXAMPLE_NAME//\//-}"

usage() {
  echo "Usage: ./scripts/run.sh <language> <platform> [--skip-install | --local]"
  echo ""
  echo "  language:  ts | go | rust | kotlin | swift"
  echo "  platform:  android | ios | web | web_canvas | web_both | both | all | server"
  echo ""
  echo "Options:"
  echo "  --skip-install   Skip app install, just start server and open deep link"
  echo "                   (assumes the runner is already installed on the device)"
  echo "  --local          Build and install the runner from local source via"
  echo "                   hypen-renderer-swift/run_on_sim.sh and"
  echo "                   hypen-renderer-android/run_on_sim.sh instead of"
  echo "                   downloading the prebuilt runner. Useful when testing"
  echo "                   local renderer changes."
  echo ""
  echo "Starts the server for the given language, then launches"
  echo "the Hypen Runner on the specified platform(s)."
  echo ""
  echo "  web:        starts the DOM renderer in your browser, connecting to the"
  echo "              language server via ws://localhost:\$PORT. Works with every"
  echo "              language since the protocol is identical."
  echo "  web_canvas: same as web but renders into a <canvas> via CanvasRenderer"
  echo "              (Hypen's Canvas 2D renderer) instead of the DOM."
  echo "              NOTE: partial — the canvas renderer is not at DOM parity"
  echo "              yet (text wrap, Stack, Image natural size, per-axis scroll,"
  echo "              scrolled hit-testing). See hypen-web/packages/web/src/canvas/"
  echo "              PARITY.md for the tracked gaps."
  echo "  web_both:   start DOM + canvas clients together (http://localhost:\$WEB_PORT"
  echo "              and http://localhost:\$WEB_CANVAS_PORT; defaults 3001 and 3002)."
  echo "  all:        language server + all renderers: Android, iOS, web (DOM), and"
  echo "              web canvas (same URLs/ports as web_both plus mobile simulators)."
  echo ""
  echo "Examples:"
  echo "  ./scripts/run.sh ts android"
  echo "  ./scripts/run.sh go ios"
  echo "  ./scripts/run.sh rust both"
  echo "  ./scripts/run.sh go web"
  echo "  ./scripts/run.sh ts web_canvas"
  echo "  ./scripts/run.sh ts web_both"
  echo "  ./scripts/run.sh ts all"
  echo "  ./scripts/run.sh ts android --skip-install"
  echo "  ./scripts/run.sh go ios --local"
  exit 1
}

if [ $# -lt 2 ]; then
  usage
fi

LANG="$1"
PLATFORM="$2"
SKIP_INSTALL=false
LOCAL=false
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=true ;;
    --local) LOCAL=true ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
  shift
done
if [ "$SKIP_INSTALL" = true ] && [ "$LOCAL" = true ]; then
  echo "Error: --skip-install and --local are mutually exclusive." >&2
  exit 1
fi
PORT="${PORT:-3000}"

# Paths to the local build-and-run scripts that ship with the renderer repos.
ANDROID_RUN_ON_SIM="$SOCIAL_DIR/../../hypen-renderer-android/run_on_sim.sh"
IOS_RUN_ON_SIM="$SOCIAL_DIR/../../hypen-renderer-swift/run_on_sim.sh"

# Validate platform
case "$PLATFORM" in
  android|ios|web|web_canvas|web_both|both|all|server) ;;
  *) echo "Error: platform must be android, ios, web, web_canvas, web_both, both, all, or server"; exit 1 ;;
esac

WEB_PORT="${WEB_PORT:-3001}"
WEB_CANVAS_PORT="${WEB_CANVAS_PORT:-3002}"

# Start the server in the background based on language
echo "Starting $LANG server on port $PORT..."

case "$LANG" in
  ts|typescript)
    cd "$SOCIAL_DIR/typescript"
    bun install --silent
    PORT="$PORT" bun run server/index.ts &
    ;;
  go)
    cd "$SOCIAL_DIR/go"
    go mod tidy -e 2>/dev/null
    echo "Building Go server..."
    go build -o "$EXAMPLE_BIN" .
    PORT="$PORT" "./$EXAMPLE_BIN" &
    ;;
  rust)
    cd "$SOCIAL_DIR/rust"
    echo "Building Rust server (this may take a while on first run)..."
    cargo build
    PORT="$PORT" cargo run --quiet &
    ;;
  kotlin)
    # Kotlin SDK requires the native engine library (UniFFI)
    echo "Building native engine (UniFFI)..."
    cd "$SOCIAL_DIR/../../hypen-engine-rs"
    cargo build --features uniffi --quiet
    cd "$SOCIAL_DIR/kotlin"
    echo "Building Kotlin server..."
    ./gradlew build --console=plain
    PORT="$PORT" ./gradlew run --quiet --console=plain &
    ;;
  swift)
    cd "$SOCIAL_DIR/swift"
    echo "Building Swift server..."
    swift build
    PORT="$PORT" swift run &
    ;;
  *)
    echo "Error: language must be ts, go, rust, kotlin, or swift"
    exit 1
    ;;
esac

SERVER_PID=$!

# Wait for the server to actually start listening
echo "Waiting for server on port $PORT..."
for i in $(seq 1 30); do
  if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Server is listening on port $PORT"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Error: server process exited before it started listening"
    exit 1
  fi
  sleep 1
done

if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: server did not start within 30s"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

WEB_PID=""
WEB_CANVAS_PID=""
cleanup() {
  echo ""
  echo "Stopping server (PID $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  if [ -n "$WEB_PID" ]; then
    echo "Stopping web client (PID $WEB_PID)..."
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [ -n "$WEB_CANVAS_PID" ]; then
    echo "Stopping web canvas client (PID $WEB_CANVAS_PID)..."
    kill "$WEB_CANVAS_PID" 2>/dev/null || true
    wait "$WEB_CANVAS_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start the web client (DOM renderer) on $WEB_PORT and open a browser tab.
# The web client is a Bun-served HTML page that connects back to ws://localhost:$PORT
# using RemoteEngine + DOMRenderer, so it works with any language backend.
start_web_client() {
  echo "Starting web client on http://localhost:$WEB_PORT ..."
  (
    cd "$SOCIAL_DIR/typescript"
    bun install --silent
    WEB_PORT="$WEB_PORT" bun web/serve.ts
  ) &
  WEB_PID=$!

  # Wait briefly for the web server to bind.
  for i in $(seq 1 15); do
    if lsof -i :"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$WEB_PID" 2>/dev/null; then
      echo "Error: web client exited before it started listening"
      return 1
    fi
    sleep 1
  done
  if ! lsof -i :"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Error: web client did not start on $WEB_PORT within 15s"
    return 1
  fi

  # Open the default browser (macOS `open`, Linux `xdg-open`, else skip).
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:$WEB_PORT"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:$WEB_PORT" >/dev/null 2>&1 &
  else
    echo "Open your browser to http://localhost:$WEB_PORT"
  fi
}

# Start the web canvas client (CanvasRenderer) on $WEB_CANVAS_PORT and open a
# browser tab. Same Bun-served pattern as the DOM client, but the page mounts
# a CanvasRenderer onto a <canvas> element instead of a <div>.
start_web_canvas_client() {
  echo "Starting web canvas client on http://localhost:$WEB_CANVAS_PORT ..."
  (
    cd "$SOCIAL_DIR/typescript"
    bun install --silent
    WEB_CANVAS_PORT="$WEB_CANVAS_PORT" bun web_canvas/serve.ts
  ) &
  WEB_CANVAS_PID=$!

  for i in $(seq 1 15); do
    if lsof -i :"$WEB_CANVAS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$WEB_CANVAS_PID" 2>/dev/null; then
      echo "Error: web canvas client exited before it started listening"
      return 1
    fi
    sleep 1
  done
  if ! lsof -i :"$WEB_CANVAS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Error: web canvas client did not start on $WEB_CANVAS_PORT within 15s"
    return 1
  fi

  if command -v open >/dev/null 2>&1; then
    open "http://localhost:$WEB_CANVAS_PORT"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:$WEB_CANVAS_PORT" >/dev/null 2>&1 &
  else
    echo "Open your browser to http://localhost:$WEB_CANVAS_PORT"
  fi
}

# Start DOM + canvas clients on separate ports (defaults: WEB_PORT=3001, WEB_CANVAS_PORT=3002).
start_web_both_clients() {
  if [ "$WEB_PORT" = "$WEB_CANVAS_PORT" ]; then
    echo "Error: WEB_PORT and WEB_CANVAS_PORT must differ for web_both (got $WEB_PORT)." >&2
    return 1
  fi
  start_web_client || return 1
  start_web_canvas_client || return 1
}

# Web (DOM + canvas) plus Android + iOS — combines web_both with the same mobile flow as \"both\".
start_all_renderers_local() {
  start_web_both_clients || return 1
  (
    echo "Building Android runner from local source..."
    "$ANDROID_RUN_ON_SIM"
    echo "Opening deep link: $ANDROID_DEEPLINK"
    adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK"
  ) &
  (
    echo "Building iOS runner from local source..."
    "$IOS_RUN_ON_SIM" --url "$IOS_URL"
  ) &
  wait
}

start_all_renderers_skip_install() {
  start_web_both_clients || return 1
  echo "Opening deep link on Android: $ANDROID_DEEPLINK"
  adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK" &
  echo "Opening deep link on iOS: $IOS_DEEPLINK"
  if ! xcrun simctl list devices booted 2>/dev/null | grep -q Booted; then
    echo "Error: no booted iOS simulator. Boot one first (e.g. open -a Simulator)." >&2
    if [ -n "${WEB_PID:-}" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
    if [ -n "${WEB_CANVAS_PID:-}" ]; then kill "$WEB_CANVAS_PID" 2>/dev/null || true; fi
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  xcrun simctl openurl booted "$IOS_DEEPLINK" &
  wait
}

start_all_renderers_default() {
  start_web_both_clients || return 1
  $HYPEN run android --url "$ANDROID_URL" &
  $HYPEN run ios --url "$IOS_URL" &
  wait
}

# Launch runner(s) via hypen CLI
HYPEN="bun $CLI_DIR/bin/hypen.ts"

# Android emulators can't reach host via localhost — use 10.0.2.2.
# iOS simulators share the host network, so localhost works.
ANDROID_URL="ws://10.0.2.2:$PORT"
IOS_URL="ws://localhost:$PORT"

urlencode() {
  # Encode :, /, ?, &, = — enough for ws://host:port URLs
  local s="$1"
  s="${s//%/%25}"
  s="${s//:/%3A}"
  s="${s//\//%2F}"
  s="${s//\?/%3F}"
  s="${s//&/%26}"
  s="${s//=/%3D}"
  printf '%s' "$s"
}

if [ "$LOCAL" = true ]; then
  # Build + install the runner from local source using the renderer repos'
  # run_on_sim.sh scripts. The iOS script accepts --url and handles the deep
  # link itself; the Android script only builds/installs/launches, so we
  # open the deep link separately via adb.
  ANDROID_DEEPLINK="hypenpreview://connect?url=$(urlencode "$ANDROID_URL")"

  if [ ! -x "$ANDROID_RUN_ON_SIM" ] && { [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "both" ] || [ "$PLATFORM" = "all" ]; }; then
    echo "Error: $ANDROID_RUN_ON_SIM not found or not executable" >&2
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  if [ ! -x "$IOS_RUN_ON_SIM" ] && { [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ] || [ "$PLATFORM" = "all" ]; }; then
    echo "Error: $IOS_RUN_ON_SIM not found or not executable" >&2
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi

  case "$PLATFORM" in
    server)
      echo "Server-only mode — press Ctrl+C to stop."
      ;;
    web)
      start_web_client
      ;;
    web_canvas)
      start_web_canvas_client
      ;;
    web_both)
      start_web_both_clients
      ;;
    android)
      echo "Building Android runner from local source..."
      "$ANDROID_RUN_ON_SIM"
      echo "Opening deep link: $ANDROID_DEEPLINK"
      adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK"
      ;;
    ios)
      echo "Building iOS runner from local source..."
      "$IOS_RUN_ON_SIM" --url "$IOS_URL"
      ;;
    both)
      (
        echo "Building Android runner from local source..."
        "$ANDROID_RUN_ON_SIM"
        echo "Opening deep link: $ANDROID_DEEPLINK"
        adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK"
      ) &
      (
        echo "Building iOS runner from local source..."
        "$IOS_RUN_ON_SIM" --url "$IOS_URL"
      ) &
      wait
      ;;
    all)
      start_all_renderers_local
      ;;
  esac
elif [ "$SKIP_INSTALL" = true ]; then
  # Skip app install — just open the deep link on already-installed runner
  ANDROID_DEEPLINK="hypenpreview://connect?url=$(urlencode "$ANDROID_URL")"
  IOS_DEEPLINK="hypenpreview://connect?url=$(urlencode "$IOS_URL")"

  case "$PLATFORM" in
    server)
      echo "Server-only mode — press Ctrl+C to stop."
      ;;
    web)
      start_web_client
      ;;
    web_canvas)
      start_web_canvas_client
      ;;
    web_both)
      start_web_both_clients
      ;;
    android)
      echo "Opening deep link on Android: $ANDROID_DEEPLINK"
      adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK"
      ;;
    ios)
      echo "Opening deep link on iOS: $IOS_DEEPLINK"
      if ! xcrun simctl list devices booted 2>/dev/null | grep -q Booted; then
        echo "Error: no booted iOS simulator. Boot one first (e.g. open -a Simulator)."
        kill "$SERVER_PID" 2>/dev/null || true
        exit 1
      fi
      xcrun simctl openurl booted "$IOS_DEEPLINK"
      ;;
    both)
      echo "Opening deep link on Android: $ANDROID_DEEPLINK"
      adb shell am start -a android.intent.action.VIEW -d "$ANDROID_DEEPLINK" &
      echo "Opening deep link on iOS: $IOS_DEEPLINK"
      xcrun simctl openurl booted "$IOS_DEEPLINK" &
      wait
      ;;
    all)
      start_all_renderers_skip_install
      ;;
  esac
else
  case "$PLATFORM" in
    server)
      echo "Server-only mode — press Ctrl+C to stop."
      ;;
    web)
      start_web_client
      ;;
    web_canvas)
      start_web_canvas_client
      ;;
    web_both)
      start_web_both_clients
      ;;
    android)
      $HYPEN run android --url "$ANDROID_URL"
      ;;
    ios)
      $HYPEN run ios --url "$IOS_URL"
      ;;
    both)
      $HYPEN run android --url "$ANDROID_URL" &
      $HYPEN run ios --url "$IOS_URL" &
      wait
      ;;
    all)
      start_all_renderers_default
      ;;
  esac
fi

# Keep alive until Ctrl+C
wait "$SERVER_PID"
