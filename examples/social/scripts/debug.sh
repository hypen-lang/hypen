#!/usr/bin/env bash
set -euo pipefail

# debug.sh — Start a Hypen server and connect an interactive debug client
# that prints all patches to console and lets you dispatch actions.
#
# Usage: ./scripts/debug.sh <language>
#
#   language:  ts | go | rust | kotlin | swift
#
# Examples:
#   ./scripts/debug.sh ts
#   ./scripts/debug.sh go
#   PORT=4000 ./scripts/debug.sh rust

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCIAL_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(cd "$SOCIAL_DIR/../.." && pwd)"

usage() {
  echo "Usage: ./scripts/debug.sh <language>"
  echo ""
  echo "  language:  ts | go | rust | kotlin | swift"
  echo ""
  echo "Starts the server, then connects an interactive debug client"
  echo "that prints all patches and lets you send actions."
  echo ""
  echo "Environment:"
  echo "  PORT   Server port (default: 3000)"
  echo ""
  echo "Interactive commands (once connected):"
  echo "  action <name> [json-payload]   Dispatch an action"
  echo "  bind <path> <value>            Dispatch __hypen_bind"
  echo "  state                          Request full state"
  echo "  quit / exit                    Disconnect"
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

LANG="$1"
PORT="${PORT:-3000}"

# Kill anything already on this port
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT already in use, attempting to free it..."
  lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

SERVER_PID=""
cleanup() {
  echo ""
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# Start the server in the background
echo "Starting $LANG server on port $PORT..."

case "$LANG" in
  ts|typescript)
    cd "$SOCIAL_DIR/typescript"
    bun install --silent
    PORT="$PORT" bun run server/index.ts &
    SERVER_PID=$!
    ;;
  go)
    cd "$SOCIAL_DIR/go"
    go mod tidy -e 2>/dev/null
    echo "Building Go server..."
    go build -o social .
    PORT="$PORT" ./social &
    SERVER_PID=$!
    ;;
  rust)
    cd "$SOCIAL_DIR/rust"
    echo "Building Rust server..."
    cargo build
    PORT="$PORT" cargo run --quiet &
    SERVER_PID=$!
    ;;
  kotlin)
    echo "Building native engine (UniFFI)..."
    cd "$ROOT_DIR/hypen-engine-rs"
    cargo build --features uniffi --quiet
    cd "$SOCIAL_DIR/kotlin"
    echo "Building Kotlin server..."
    ./gradlew build --console=plain
    PORT="$PORT" ./gradlew run --quiet --console=plain &
    SERVER_PID=$!
    ;;
  swift)
    cd "$SOCIAL_DIR/swift"
    echo "Building Swift server..."
    swift build
    PORT="$PORT" swift run &
    SERVER_PID=$!
    ;;
  *)
    echo "Error: language must be ts, go, rust, kotlin, or swift"
    exit 1
    ;;
esac

# Wait for the server to start listening
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
echo "=== Debug Client ==="
echo ""

# Run the interactive debug client (blocks until quit)
node "$SCRIPT_DIR/debug-client.js" "$PORT"
