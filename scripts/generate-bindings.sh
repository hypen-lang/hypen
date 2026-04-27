#!/bin/bash
set -e

# Generate native bindings (Kotlin, Swift) using UniFFI

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Generating native bindings...${NC}"
echo ""

# Build release library first
echo -e "${GREEN}Building release library...${NC}"
cd "$ROOT_DIR/hypen-engine-rs"
cargo build --release --features uniffi

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    LIB_EXT="dylib"
    LIB_PREFIX="lib"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    LIB_EXT="so"
    LIB_PREFIX="lib"
else
    echo "Unsupported platform: $OSTYPE"
    exit 1
fi

LIB_PATH="$ROOT_DIR/target/release/${LIB_PREFIX}hypen_engine.${LIB_EXT}"

if [ ! -f "$LIB_PATH" ]; then
    echo "Library not found at $LIB_PATH"
    exit 1
fi

# Generate Kotlin bindings
echo ""
echo -e "${GREEN}Generating Kotlin bindings...${NC}"
cargo run --bin uniffi-bindgen --features uniffi -- generate \
    --library "$LIB_PATH" \
    --language kotlin \
    --out-dir "$ROOT_DIR/hypen-kotlin/src/main/kotlin"
echo -e "${GREEN}✓ Kotlin bindings generated at hypen-kotlin/src/main/kotlin${NC}"

# Generate Swift bindings (into hypen-server-swift)
if [ -d "$ROOT_DIR/hypen-server-swift" ]; then
    echo ""
    echo -e "${GREEN}Generating Swift bindings...${NC}"
    cargo run --bin uniffi-bindgen --features uniffi -- generate \
        --library "$LIB_PATH" \
        --language swift \
        --out-dir "$ROOT_DIR/hypen-server-swift/generated-bindings"
    # Move generated files to proper SPM target locations
    cp "$ROOT_DIR/hypen-server-swift/generated-bindings/hypen_engine.swift" \
       "$ROOT_DIR/hypen-server-swift/Sources/HypenEngine/hypen_engine.swift"
    cp "$ROOT_DIR/hypen-server-swift/generated-bindings/hypen_engineFFI.h" \
       "$ROOT_DIR/hypen-server-swift/Sources/hypen_engineFFI/hypen_engineFFI.h"
    rm -rf "$ROOT_DIR/hypen-server-swift/generated-bindings"
    # Patch: replace fatalError on CALL_CANCELLED with CancellationError
    sed -i.bak 's/fatalError("Cancellation not supported yet")/throw CancellationError()/' \
        "$ROOT_DIR/hypen-server-swift/Sources/HypenEngine/hypen_engine.swift"
    rm -f "$ROOT_DIR/hypen-server-swift/Sources/HypenEngine/hypen_engine.swift.bak"
    echo -e "${GREEN}✓ Swift bindings generated at hypen-server-swift/Sources/HypenEngine${NC}"
fi

echo ""
echo -e "${GREEN}✓ All bindings generated!${NC}"
echo ""
echo "Don't forget to:"
echo "  1. Copy the native library to the appropriate location for each platform"
echo "  2. Update version numbers in build.gradle.kts / Package.swift if needed"
