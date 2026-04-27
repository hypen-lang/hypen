#!/usr/bin/env bash
set -euo pipefail

# test-nested-modules.sh <language> [port]
#
# Starts the server for the given language, runs the node.js WebSocket test,
# kills the server, and reports results.
#
# Supported languages: swift, go, rust, kotlin, ts
# Default port: 3000

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCIAL_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(cd "$SOCIAL_DIR/../.." && pwd)"

LANG="${1:-swift}"
PORT="${2:-3000}"

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    echo ""
    echo "Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT SIGINT SIGTERM

# Kill anything already on this port
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT already in use, attempting to free it..."
  lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

echo "=== Nested Module Smoke Test ==="
echo "Language: $LANG"
echo "Port:     $PORT"
echo ""

# Start the server
case "$LANG" in
  swift)
    echo "Building Swift server..."
    cd "$SOCIAL_DIR/swift"
    swift build 2>&1 | tail -3
    echo "Starting Swift server..."
    DYLD_LIBRARY_PATH="$ROOT_DIR/target/release" PORT="$PORT" swift run 2>&1 &
    SERVER_PID=$!
    ;;
  go)
    echo "Building Go server..."
    cd "$SOCIAL_DIR/go"
    go build -o social . 2>&1 | tail -3
    echo "Starting Go server..."
    PORT="$PORT" ./social 2>&1 &
    SERVER_PID=$!
    ;;
  rust)
    echo "Building Rust server..."
    cd "$SOCIAL_DIR/rust"
    cargo build 2>&1 | tail -3
    echo "Starting Rust server..."
    PORT="$PORT" cargo run --quiet 2>&1 &
    SERVER_PID=$!
    ;;
  kotlin)
    echo "Building native engine..."
    cd "$ROOT_DIR/hypen-engine-rs"
    cargo build --features uniffi --quiet 2>&1 | tail -3
    cd "$SOCIAL_DIR/kotlin"
    echo "Building Kotlin server..."
    ./gradlew build --console=plain 2>&1 | tail -3
    echo "Starting Kotlin server..."
    PORT="$PORT" ./gradlew run --quiet --console=plain 2>&1 &
    SERVER_PID=$!
    ;;
  ts|typescript)
    cd "$SOCIAL_DIR/typescript"
    bun install --silent
    echo "Starting TypeScript server..."
    PORT="$PORT" bun run server/index.ts 2>&1 &
    SERVER_PID=$!
    ;;
  *)
    echo "Error: unsupported language '$LANG'. Use: swift, go, rust, kotlin, ts"
    exit 1
    ;;
esac

# Wait for server to start listening
echo "Waiting for server on port $PORT..."
for i in $(seq 1 60); do
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
  echo "Error: server did not start within 60s"
  exit 1
fi

echo ""
echo "--- Running WebSocket test ---"
echo ""

# Run the node test
node "$SCRIPT_DIR/test-nested-modules.js" "$PORT"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo "=== PASSED: $LANG nested module smoke test ==="
else
  echo "=== FAILED: $LANG nested module smoke test ==="
fi

exit $TEST_EXIT
