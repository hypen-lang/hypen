#!/bin/bash
set -e

# Master script to build, test, bump, and publish everything.
# Usage: ./scripts/publish-all.sh [patch|minor|major|<x.y.z>]
#
# Pass an explicit semver (e.g. 0.5.0) to pin the release to that version
# instead of auto-incrementing from the current one. Anything containing a
# "." is treated as a direct version and forwarded to bump-versions.sh as
# both the Rust and npm version.
#
# Pipeline:
#   1. Bump versions (Rust + npm)
#   2. Run tests (parser, engine, web SDK, CLI)
#   3. Build WASM (+ auto-copy to SDK locations)
#   4. Build npm packages (core, web, server, web-engine, cf, lsp, cli) with type declarations
#   5. Publish Rust crates (parser -> tailwind-parse -> engine)
#   6. Publish npm packages (hypen-engine -> core -> web -> server -> web-engine -> cf -> lsp -> cli)
#
# Flags:
#   --skip-tests     Skip test step
#   --skip-crates    Skip Rust crate publishing
#   --skip-bump      Skip version bump (resume after a failed run)
#   --skip-wasm      Skip WASM build (resume after a failed run)
#   --skip-gradle    Skip Gradle (Android renderer + Kotlin SDK) publishing
#   --skip-npm       Skip npm package publishing
#   --npm-only       Shortcut for --skip-bump --skip-tests --skip-wasm --skip-crates --skip-gradle
#   --allow-dirty    Allow dirty git working tree
#
# Gradle publishing requires Maven Central credentials. The vanniktech plugin
# reads them from Gradle properties (e.g. ~/.gradle/gradle.properties):
#   mavenCentralUsername=...
#   mavenCentralPassword=...
#   signing.keyId=...
#   signing.password=...
#   signing.secretKeyRingFile=...

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BUMP_ARG=${1:-patch}

# Flags
SKIP_TESTS=false
SKIP_RUST_TESTS=false
SKIP_CRATES=false
SKIP_BUMP=false
SKIP_WASM=false
SKIP_GRADLE=false
SKIP_NPM=false
ALLOW_DIRTY=false

for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-crates) SKIP_CRATES=true ;;
    --skip-bump) SKIP_BUMP=true ;;
    --skip-wasm) SKIP_WASM=true ;;
    --skip-gradle) SKIP_GRADLE=true ;;
    --skip-npm) SKIP_NPM=true ;;
    --npm-only) SKIP_BUMP=true; SKIP_WASM=true; SKIP_CRATES=true; SKIP_RUST_TESTS=true; SKIP_GRADLE=true ;;
    --allow-dirty) ALLOW_DIRTY=true ;;
  esac
done

# Resolve the bump arg. A dot in the value means "explicit semver" — forward
# it to bump-versions.sh as both the Rust and npm version. Otherwise treat it
# as a bump type (patch|minor|major).
if [[ "$BUMP_ARG" == *.* ]]; then
  BUMP_ARGS=("$BUMP_ARG" "$BUMP_ARG")
  BUMP_LABEL="$BUMP_ARG"
else
  BUMP_ARGS=("$BUMP_ARG")
  BUMP_LABEL="$BUMP_ARG"
fi

echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}   Hypen Full Release Pipeline${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""

# ============================================================================
# Step 0: Pre-checks
# ============================================================================

echo -e "${YELLOW}[Pre-check] Verifying prerequisites...${NC}"

# Check npm auth (only if npm publishing is enabled)
if [ "$SKIP_NPM" = false ]; then
  if ! npm whoami &>/dev/null; then
    echo -e "${RED}✗ Not logged in to npm. Run 'npm login' or set up .npmrc.${NC}"
    exit 1
  fi
  echo -e "  npm: logged in as $(npm whoami)"
fi

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

# Check java (only if Gradle publishing is enabled)
if [ "$SKIP_GRADLE" = false ]; then
  if ! command -v java &>/dev/null; then
    echo -e "${RED}✗ java not found. Install JDK 17+ or pass --skip-gradle.${NC}"
    exit 1
  fi
  echo -e "  java: $(java -version 2>&1 | head -1 | awk -F'"' '{print $2}')"
fi

# Check git state
if [ "$ALLOW_DIRTY" = false ] && [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  echo -e "${RED}✗ Working tree is dirty. Commit/stash changes or use --allow-dirty.${NC}"
  git -C "$ROOT_DIR" status --short
  exit 1
fi

echo -e "${GREEN}✓ All prerequisites met${NC}"
echo ""

# ============================================================================
# Step 1: Bump versions
# ============================================================================

if [ "$SKIP_BUMP" = true ]; then
  echo -e "${YELLOW}[Step 1/7] Skipping version bump (--skip-bump)${NC}"
else
  echo -e "${YELLOW}[Step 1/7] Bumping versions ($BUMP_LABEL)...${NC}"
  "$SCRIPT_DIR/bump-versions.sh" "${BUMP_ARGS[@]}"
fi
echo ""

# ============================================================================
# Step 2: Run tests
# ============================================================================

if [ "$SKIP_TESTS" = true ]; then
  echo -e "${YELLOW}[Step 2/7] Skipping tests (--skip-tests)${NC}"
else
  echo -e "${YELLOW}[Step 2/7] Running tests...${NC}"

  if [ "$SKIP_RUST_TESTS" = true ]; then
    echo -e "  ${YELLOW}Skipping Rust tests${NC}"
  else
    echo -e "  Testing parser..."
    cd "$ROOT_DIR/parser" && cargo test --quiet
    echo -e "  ${GREEN}✓ parser${NC}"

    echo -e "  Testing engine..."
    cd "$ROOT_DIR/hypen-engine-rs" && cargo test --quiet
    echo -e "  ${GREEN}✓ engine${NC}"

    echo -e "  Testing hypen-server..."
    cd "$ROOT_DIR/hypen-sdk-rs" && cargo test --quiet
    echo -e "  ${GREEN}✓ hypen-server${NC}"
  fi

  echo -e "  Testing web SDK..."
  cd "$ROOT_DIR/hypen-web" && bun test 2>&1 | tail -3
  echo -e "  ${GREEN}✓ web SDK${NC}"

  echo -e "${GREEN}✓ All tests passed${NC}"
fi
echo ""

# ============================================================================
# Step 3: Build WASM (+ auto-copy to SDK locations)
# ============================================================================

if [ "$SKIP_WASM" = true ]; then
  echo -e "${YELLOW}[Step 3/7] Skipping WASM build (--skip-wasm)${NC}"
else
  echo -e "${YELLOW}[Step 3/7] Building WASM...${NC}"
  cd "$ROOT_DIR/hypen-engine-rs"
  "$ROOT_DIR/hypen-engine-rs/build-wasm.sh"
  echo -e "${GREEN}✓ WASM built and copied to SDK${NC}"
fi
echo ""

# ============================================================================
# Step 4: Build npm packages (with type declarations)
# ============================================================================

echo -e "${YELLOW}[Step 4/7] Building npm packages...${NC}"

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

echo -e "  Building @hypen-space/device-web..."
cd "$ROOT_DIR/hypen-web/packages/device-web" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/device-web built${NC}"

echo -e "  Building @hypen-space/device-fake..."
cd "$ROOT_DIR/hypen-web/packages/device-fake" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/device-fake built${NC}"

echo -e "  Building @hypen-space/agent..."
cd "$ROOT_DIR/hypen-web/packages/agent" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/agent built${NC}"

echo -e "  Building @hypen-space/cf..."
cd "$ROOT_DIR/hypen-web/packages/cf" && bun run build
echo -e "  ${GREEN}✓ @hypen-space/cf built${NC}"

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
if [ ! -f "$ROOT_DIR/hypen-web/packages/cf/dist/index.d.ts" ]; then
  echo -e "${RED}✗ Missing cf type declarations (dist/index.d.ts)${NC}"
  exit 1
fi
echo -e "${GREEN}✓ All packages built with type declarations${NC}"
echo ""

# ============================================================================
# Step 5: Publish Rust crates
# ============================================================================

if [ "$SKIP_CRATES" = true ]; then
  echo -e "${YELLOW}[Step 5/7] Skipping Rust crates (--skip-crates)${NC}"
else
  echo -e "${YELLOW}[Step 5/7] Publishing Rust crates...${NC}"
  # Always --allow-dirty here because Step 1 (bump-versions) dirties the tree
  "$SCRIPT_DIR/publish-crates.sh" --allow-dirty
  echo -e "${GREEN}✓ Rust crates published${NC}"
fi
echo ""

# ============================================================================
# Step 6: Publish npm packages (order: hypen-engine -> core -> web -> server -> web-engine -> cf -> lsp -> cli)
# ============================================================================

if [ "$SKIP_NPM" = true ]; then
  echo -e "${YELLOW}[Step 6/7] Skipping npm publishing (--skip-npm)${NC}"
else
  echo -e "${YELLOW}[Step 6/7] Publishing npm packages...${NC}"

  # hypen-engine = the browser WASM build (wasm-browser). The node WASM build
  # is NOT published standalone — it ships inside @hypen-space/server.
  echo -e "  Publishing hypen-engine (wasm-browser)..."
  cd "$ROOT_DIR/hypen-web/packages/web-engine/wasm-browser" && npm publish --access public
  echo -e "  ${GREEN}✓ hypen-engine published${NC}"

  echo -e "  Publishing @hypen-space/core..."
  cd "$ROOT_DIR/hypen-web/packages/core" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/core published${NC}"

  echo -e "  Publishing @hypen-space/web..."
  cd "$ROOT_DIR/hypen-web/packages/web" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/web published${NC}"

  echo -e "  Publishing @hypen-space/server..."
  cd "$ROOT_DIR/hypen-web/packages/server" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/server published${NC}"

  echo -e "  Publishing @hypen-space/web-engine..."
  cd "$ROOT_DIR/hypen-web/packages/web-engine" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/web-engine published${NC}"

  # device-web / device-fake / agent depend only on core (published above).
  # device-web MUST publish before cf, which depends on it.
  echo -e "  Publishing @hypen-space/device-web..."
  cd "$ROOT_DIR/hypen-web/packages/device-web" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/device-web published${NC}"

  echo -e "  Publishing @hypen-space/device-fake..."
  cd "$ROOT_DIR/hypen-web/packages/device-fake" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/device-fake published${NC}"

  echo -e "  Publishing @hypen-space/agent..."
  cd "$ROOT_DIR/hypen-web/packages/agent" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/agent published${NC}"

  echo -e "  Publishing @hypen-space/cf..."
  cd "$ROOT_DIR/hypen-web/packages/cf" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/cf published${NC}"

  echo -e "  Publishing @hypen-space/lsp..."
  cd "$ROOT_DIR/hypen-lsp" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/lsp published${NC}"

  # Refresh hypen-cli's lockfiles now that all its @hypen-space/* deps are on
  # npm — so the cli tarball ships a bun.lock that matches its package.json.
  echo -e "  Refreshing hypen-cli lockfiles..."
  (cd "$ROOT_DIR/hypen-cli" && bun install --silent > /dev/null 2>&1) \
      && echo -e "  ${GREEN}✓ hypen-cli/bun.lock${NC}" \
      || echo -e "  ${YELLOW}⚠ hypen-cli/bun.lock refresh failed${NC}"
  (cd "$ROOT_DIR/hypen-cli/studio-ui" && bun install --silent > /dev/null 2>&1) \
      && echo -e "  ${GREEN}✓ hypen-cli/studio-ui/bun.lock${NC}" \
      || echo -e "  ${YELLOW}⚠ hypen-cli/studio-ui/bun.lock refresh failed${NC}"

  echo -e "  Publishing @hypen-space/cli..."
  cd "$ROOT_DIR/hypen-cli" && npm publish --access public
  echo -e "  ${GREEN}✓ @hypen-space/cli published${NC}"
fi

echo ""

# ============================================================================
# Step 7: Publish Gradle packages (hypen-renderer-android, hypen-kotlin) to Maven Central
# ============================================================================

if [ "$SKIP_GRADLE" = true ]; then
  echo -e "${YELLOW}[Step 7/7] Skipping Gradle publishing (--skip-gradle)${NC}"
else
  echo -e "${YELLOW}[Step 7/7] Publishing Gradle packages to Maven Central...${NC}"

  # hypen-kotlin loads libhypen_engine via JNA at test time; the uniffi release
  # build must exist before `./gradlew build` runs during publish.
  echo -e "  Building UniFFI native library..."
  cd "$ROOT_DIR/hypen-engine-rs" && cargo build --release --features uniffi --quiet
  echo -e "  ${GREEN}✓ UniFFI native library built${NC}"

  echo -e "  Publishing hypen-renderer (Android)..."
  cd "$ROOT_DIR/hypen-renderer-android" && ./gradlew :renderer:publishAndReleaseToMavenCentral --quiet
  echo -e "  ${GREEN}✓ hypen-renderer published${NC}"

  echo -e "  Publishing hypen-kotlin..."
  cd "$ROOT_DIR/hypen-kotlin" && ./gradlew publishAndReleaseToMavenCentral --quiet
  echo -e "  ${GREEN}✓ hypen-kotlin published${NC}"

  echo -e "${GREEN}✓ Gradle packages published${NC}"
fi
echo ""

# ============================================================================
# Done
# ============================================================================

# Read the new version from core's package.json
NEW_VERSION=$(cd "$ROOT_DIR" && grep '"version"' hypen-web/packages/core/package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
NEW_LSP_VERSION=$(cd "$ROOT_DIR" && grep '"version"' hypen-lsp/package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

echo -e "${BLUE}=====================================${NC}"
echo -e "${GREEN}   Release v${NEW_VERSION} complete!${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""
echo "Published:"
echo "  Rust crates:"
echo "    - hypen-parser@${NEW_VERSION}"
echo "    - hypen-tailwind-parse@${NEW_VERSION}"
echo "    - hypen-engine@${NEW_VERSION}"
echo "    - hypen-server@${NEW_VERSION}"
if [ "$SKIP_NPM" = false ]; then
  echo "  npm packages:"
  echo "    - hypen-engine@${NEW_VERSION}"
  echo "    - @hypen-space/core@${NEW_VERSION}"
  echo "    - @hypen-space/web@${NEW_VERSION}"
  echo "    - @hypen-space/server@${NEW_VERSION}"
  echo "    - @hypen-space/web-engine@${NEW_VERSION}"
  echo "    - @hypen-space/cf@${NEW_VERSION}"
  echo "    - @hypen-space/lsp@${NEW_LSP_VERSION}"
  echo "    - @hypen-space/cli@${NEW_VERSION}"
fi
if [ "$SKIP_GRADLE" = false ]; then
  echo "  Maven Central:"
  echo "    - space.hypen:hypen-renderer:${NEW_VERSION}"
  echo "    - space.hypen:hypen-kotlin:${NEW_VERSION}"
fi
echo ""
echo "Verify:"
if [ "$SKIP_NPM" = false ]; then
  echo "  https://www.npmjs.com/package/hypen-engine"
  echo "  https://www.npmjs.com/package/@hypen-space/core"
  echo "  https://www.npmjs.com/package/@hypen-space/web"
  echo "  https://www.npmjs.com/package/@hypen-space/server"
  echo "  https://www.npmjs.com/package/@hypen-space/web-engine"
  echo "  https://www.npmjs.com/package/@hypen-space/cf"
  echo "  https://www.npmjs.com/package/@hypen-space/lsp"
fi
if [ "$SKIP_CRATES" = false ]; then
  echo "  https://crates.io/crates/hypen-engine"
  echo "  https://crates.io/crates/hypen-server"
fi
if [ "$SKIP_GRADLE" = false ]; then
  echo "  https://central.sonatype.com/artifact/space.hypen/hypen-renderer"
  echo "  https://central.sonatype.com/artifact/space.hypen/hypen-kotlin"
fi
