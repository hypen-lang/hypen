#!/bin/bash

# Run HypenGallery web server and component gallery server
# Usage: ./run_on_sim.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GALLERY_SERVER_DIR="$SCRIPT_DIR/../../component-gallery-server"

echo "Starting Hypen Web Gallery..."

# Check if component-gallery-server is already running
if lsof -i :6555 > /dev/null 2>&1; then
    echo "Component gallery server already running on port 6555"
else
    echo "Starting component gallery server..."
    cd "$GALLERY_SERVER_DIR"
    bun run server.ts &
    GALLERY_PID=$!
    echo "Component gallery server started (PID: $GALLERY_PID)"
    sleep 2
fi

# Check if web gallery server is already running
if lsof -i :5556 > /dev/null 2>&1; then
    echo "Web gallery server already running on port 5556"
else
    echo "Starting web gallery server..."
    cd "$SCRIPT_DIR"
    bun run gallery-server.ts &
    WEB_PID=$!
    echo "Web gallery server started (PID: $WEB_PID)"
    sleep 1
fi

echo ""
echo "Gallery is ready!"
echo "  Web Gallery: http://localhost:5556"
echo "  Component Server: ws://localhost:6555"
echo ""
echo "Open a component:"
echo "  http://localhost:5556?name=button"
echo "  http://localhost:5556?name=column"
echo ""
echo "Press Ctrl+C to stop servers"

# Wait for servers
wait
