#!/bin/bash
set -e

# Publish Rust crates to crates.io
# Order matters: parser -> tailwind-parse -> engine -> server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ALLOW_DIRTY=""
if [ "$1" == "--allow-dirty" ]; then
    ALLOW_DIRTY="--allow-dirty"
fi

echo -e "${YELLOW}Publishing Rust crates to crates.io...${NC}"
echo ""

# 1. Publish hypen-parser
echo -e "${GREEN}[1/4] Publishing hypen-parser...${NC}"
cd "$ROOT_DIR/parser"
cargo publish $ALLOW_DIRTY
echo -e "${GREEN}✓ hypen-parser published${NC}"
echo ""

# 2. Publish hypen-tailwind-parse
echo -e "${GREEN}[2/4] Publishing hypen-tailwind-parse...${NC}"
cd "$ROOT_DIR/tailwind-parse"
cargo publish $ALLOW_DIRTY
echo -e "${GREEN}✓ hypen-tailwind-parse published${NC}"
echo ""

# 3. Publish hypen-engine
echo -e "${GREEN}[3/4] Publishing hypen-engine...${NC}"
cd "$ROOT_DIR/hypen-engine-rs"
cargo publish $ALLOW_DIRTY
echo -e "${GREEN}✓ hypen-engine published${NC}"
echo ""

# 4. Publish hypen-server
echo -e "${GREEN}[4/4] Publishing hypen-server...${NC}"
cd "$ROOT_DIR/hypen-sdk-rs"
cargo publish $ALLOW_DIRTY
echo -e "${GREEN}✓ hypen-server published${NC}"
echo ""

echo -e "${GREEN}✓ All crates published!${NC}"
echo ""
echo "Verify at:"
echo "  https://crates.io/crates/hypen-parser"
echo "  https://crates.io/crates/hypen-tailwind-parse"
echo "  https://crates.io/crates/hypen-engine"
echo "  https://crates.io/crates/hypen-server"
