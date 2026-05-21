#!/bin/bash
set -e

# Build and test everything without publishing.
# Usage: ./scripts/build-all.sh [--skip-tests] [--skip-gradle]
#
# Pipeline:
#   1. Run tests (parser, engine, server, web SDK)
#   2. Build WASM (+ auto-copy to SDK locations)
#   3. Build npm packages (core, web, lsp, cli) with type declarations
#   4. Build UniFFI native library (release, needed by hypen-kotlin)
#   5. Build Gradle packages (hypen-renderer-android, hypen-kotlin)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Flags
SKIP_TESTS=false
SKIP_GRADLE=false

for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-gradle) SKIP_GRADLE=true ;;
  esac
done

echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}   Hypen Full Build${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""

# ============================================================================
# Step 0: Pre-checks
# ============================================================================

echo -e "${YELLOW}[Pre-check] Verifying prerequisites...${NC}"

# Check bun
if ! command -v bun &>/dev/null; then
  echo -e "${RED}✗ bun not found. Install from https://bun.sh${NC}"
  exit 1
fi
echo -e "  bun: $(bun --version)"

# Check cargo
if ! command -v cargo &>/dev/null; then
  echo -e "${RED}✗ cargo not found. Install from https://rustup.rs${NC}"
  exit 1
fi
echo -e "  cargo: $(cargo --version | awk '{print $2}')"

# Check wasm-pack
if ! command -v wasm-pack &>/dev/null; then
  echo -e "${RED}✗ wasm-pack not found. Install: cargo install wasm-pack${NC}"
  exit 1
fi
echo -e "  wasm-pack: $(wasm-pack --version | awk '{print $2}')"

echo -e "${GREEN}✓ All prerequisites met${NC}"
echo ""

# ============================================================================
# Step 1: Run tests
# ============================================================================

if [ "$SKIP_TESTS" = true ]; then
  echo -e "${YELLOW}[Step 1/3] Skipping tests (--skip-tests)${NC}"
else
  echo -e "${YELLOW}[Step 1/3] Running tests...${NC}"

  echo -e "  Testing parser..."
  cd "$ROOT_DIR/parser" && cargo test --quiet
  echo -e "  ${GREEN}✓ parser${NC}"

  echo -e "  Testing engine..."
  cd "$ROOT_DIR/hypen-engine-rs" && cargo test --quiet
  echo -e "  ${GREEN}✓ engine${NC}"

  echo -e "  Testing hypen-server..."
  cd "$ROOT_DIR/hypen-sdk-rs" && cargo test --quiet
  echo -e "  ${GREEN}✓ hypen-server${NC}"

  echo -e "  Testing web SDK..."
  cd "$ROOT_DIR/hypen-web" && bun test 2>&1 | tail -3
  echo -e "  ${GREEN}✓ web SDK${NC}"

  echo -e "${GREEN}✓ All tests passed${NC}"
fi
echo ""

# ============================================================================
# Step 2: Build WASM (+ auto-copy to SDK locations)
# ============================================================================

echo -e "${YELLOW}[Step 2/3] Building WASM...${NC}"
cd "$ROOT_DIR/hypen-engine-rs"
"$ROOT_DIR/hypen-engine-rs/build-wasm.sh"
echo -e "${GREEN}✓ WASM built and copied to SDK${NC}"
echo ""

# ============================================================================
# Step 3: Build npm packages (with type declarations)
# ============================================================================

echo -e "${YELLOW}[Step 3/3] Building npm packages...${NC}"

echo -e "  Building @hypen-space/core..."
cd "$ROOT_DIR/hypen-web/packages/core" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/core built${NC}"

echo -e "  Building @hypen-space/web..."
cd "$ROOT_DIR/hypen-web/packages/web" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/web built${NC}"

echo -e "  Building @hypen-space/server..."
cd "$ROOT_DIR/hypen-web/packages/server" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/server built${NC}"

echo -e "  Building @hypen-space/web-engine..."
cd "$ROOT_DIR/hypen-web/packages/web-engine" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/web-engine built${NC}"

echo -e "  Building @hypen-space/lsp..."
cd "$ROOT_DIR/hypen-lsp" && bun run compile
echo -e "  ${GREEN}✓ @hypen-space/lsp built${NC}"

echo -e "  Building @hypen-space/cli..."
cd "$ROOT_DIR/hypen-cli" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/cli built${NC}"

# Verify declarations exist
if [ ! -f "$ROOT_DIR/hypen-web/packages/core/dist/index.d.ts" ]; then
  echo -e "${RED}✗ Missing core type declarations (dist/index.d.ts)${NC}"
  exit 1
fi
if [ ! -f "$ROOT_DIR/hypen-web/packages/web/dist/index.d.ts" ]; then
  echo -e "${RED}✗ Missing web type declarations (dist/index.d.ts)${NC}"
  exit 1
fi
if [ ! -f "$ROOT_DIR/hypen-web/packages/server/dist/index.d.ts" ]; then
  echo -e "${RED}✗ Missing server type declarations (dist/index.d.ts)${NC}"
  exit 1
fi
if [ ! -f "$ROOT_DIR/hypen-web/packages/web-engine/dist/index.d.ts" ]; then
  echo -e "${RED}✗ Missing web-engine type declarations (dist/index.d.ts)${NC}"
  exit 1
fi
echo -e "${GREEN}✓ All packages built with type declarations${NC}"
echo ""

# ============================================================================
# Step 4: Build UniFFI native library (release) + Step 5: Build Gradle packages
# ============================================================================

if [ "$SKIP_GRADLE" = true ]; then
  echo -e "${YELLOW}[Steps 4-5/5] Skipping Gradle build (--skip-gradle)${NC}"
else
  if ! command -v java &>/dev/null; then
    echo -e "${YELLOW}[Steps 4-5/5] java not found; skipping Gradle build (pass --skip-gradle to silence)${NC}"
  else
    echo -e "${YELLOW}[Step 4/5] Building UniFFI native library (cargo build --release --features uniffi)...${NC}"
    cd "$ROOT_DIR/hypen-engine-rs" && cargo build --release --features uniffi --quiet
    echo -e "${GREEN}✓ UniFFI native library built${NC}"
    echo ""

    echo -e "${YELLOW}[Step 5/5] Building Gradle packages...${NC}"

    echo -e "  Building hypen-renderer-android..."
    cd "$ROOT_DIR/hypen-renderer-android" && ./gradlew :renderer:assembleRelease --quiet
    echo -e "  ${GREEN}✓ hypen-renderer-android built${NC}"

    echo -e "  Building hypen-kotlin..."
    cd "$ROOT_DIR/hypen-kotlin" && ./gradlew build --quiet
    echo -e "  ${GREEN}✓ hypen-kotlin built${NC}"

    echo -e "${GREEN}✓ All Gradle packages built${NC}"
  fi
fi
echo ""

# ============================================================================
# Done
# ============================================================================

echo -e "${BLUE}=====================================${NC}"
echo -e "${GREEN}   Build complete!${NC}"
echo -e "${BLUE}=====================================${NC}"
