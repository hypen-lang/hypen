#!/usr/bin/env bash
# Start the Calorie Counter TypeScript dev server, then build HypenGallery on
# the iOS Simulator and deep-link it to ws://localhost:$PORT (same pattern as
# examples/social/scripts/run.sh ts ios --local).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAL_DIR="$(dirname "$SCRIPT_DIR")"
ROOT="$(cd "$CAL_DIR/../.." && pwd)"
TS_DIR="$CAL_DIR/typescript"
IOS_RUN_ON_SIM="$ROOT/hypen-renderer-swift/run_on_sim.sh"
PORT="${PORT:-3000}"

if [ ! -x "$IOS_RUN_ON_SIM" ]; then
  echo "Error: $IOS_RUN_ON_SIM not found or not executable" >&2
  exit 1
fi

cd "$TS_DIR"
bun install --silent
PORT="$PORT" bun run server/index.ts &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Stopping server (PID $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup SIGINT SIGTERM

echo "Waiting for server on port $PORT..."
for _ in $(seq 1 30); do
  if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Server is listening on port $PORT"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Error: server process exited before it started listening" >&2
    exit 1
  fi
  sleep 1
done

if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: server did not start within 30s" >&2
  cleanup
  exit 1
fi

IOS_URL="ws://localhost:$PORT"
echo "Building iOS HypenGallery from local source..."
"$IOS_RUN_ON_SIM" --url "$IOS_URL"

echo "Gallery connected. Server still running — press Ctrl+C to stop."
wait "$SERVER_PID"
