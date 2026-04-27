#!/bin/bash
set -e

# Build WASM and copy to npm packages

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Building WASM...${NC}"

# Build WASM using the engine's build script
cd "$ROOT_DIR/hypen-engine-rs"
./build-wasm.sh

echo ""
echo -e "${GREEN}Building npm packages (copies WASM)...${NC}"

# Build core
cd "$ROOT_DIR/hypen-web/packages/core"
bun run build
echo -e "${GREEN}✓ @hypen-space/core built${NC}"

# Build web
cd "$ROOT_DIR/hypen-web/packages/web"
bun run build
echo -e "${GREEN}✓ @hypen-space/web built${NC}"

# Build server (copies WASM Node.js files)
cd "$ROOT_DIR/hypen-web/packages/server"
bun run build
echo -e "${GREEN}✓ @hypen-space/server built${NC}"

# Build web-engine (copies WASM browser files)
cd "$ROOT_DIR/hypen-web/packages/web-engine"
bun run build
echo -e "${GREEN}✓ @hypen-space/web-engine built${NC}"

# Build cli
cd "$ROOT_DIR/hypen-cli"
bun run build
echo -e "${GREEN}✓ @hypen-space/cli built${NC}"

echo ""
echo -e "${GREEN}✓ All WASM builds complete!${NC}"
