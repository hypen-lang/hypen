#!/bin/bash
set -e

# Build the native Rust engine library required by HypenServer.
#
# This compiles hypen-engine-rs with the UniFFI feature and outputs
# the path to set as DYLD_LIBRARY_PATH / LD_LIBRARY_PATH for tests.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$WORKSPACE_DIR/hypen-engine-rs"

GREEN='\033[0;32m'
NC='\033[0m'

echo "Building native engine library..."
cd "$ENGINE_DIR"
cargo build --release --features uniffi

# The workspace target dir lives at the workspace root, not under hypen-engine-rs.
LIB_DIR="$WORKSPACE_DIR/target/release"

echo ""
echo -e "${GREEN}Build complete.${NC}"
echo ""
echo "To run tests, set the library path:"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  export DYLD_LIBRARY_PATH=$LIB_DIR"
    echo "  export LIBRARY_PATH=$LIB_DIR"
    echo ""
    echo "  DYLD_LIBRARY_PATH=$LIB_DIR LIBRARY_PATH=$LIB_DIR swift test"
else
    echo "  export LD_LIBRARY_PATH=$LIB_DIR"
    echo "  export LIBRARY_PATH=$LIB_DIR"
    echo ""
    echo "  LD_LIBRARY_PATH=$LIB_DIR LIBRARY_PATH=$LIB_DIR swift test"
fi
