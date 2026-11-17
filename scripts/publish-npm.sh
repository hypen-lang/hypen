#!/bin/bash
set -e

# Publish npm packages
# Order matters (dependencies first; the same order as scripts/publish-all.sh and
# .github/workflows/release.yml): hypen-engine -> core -> module-host -> web ->
# server -> web-engine -> device-web -> device-fake -> agent -> cf -> lsp -> cli
# (+ ios-streamer, independent).
#
# A package that has never been published (a new @hypen-space/* package) must
# get its first release from here, by hand: npm trusted publishing (OIDC, used
# by release.yml) can only be configured for a package that already exists.
# See CONTRIBUTING.md, "Releasing".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

OTP=""
if [ -n "$1" ]; then
    OTP="--otp=$1"
fi

echo -e "${YELLOW}Publishing npm packages...${NC}"
echo ""

# Check npm login
echo "Checking npm authentication..."
if ! npm whoami &>/dev/null; then
    echo -e "${RED}Not logged in to npm. Run 'npm login' first.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Logged in as $(npm whoami)${NC}"
echo ""

# 1. hypen-engine (browser WASM build; the node WASM build ships
#    inside @hypen-space/server and is not published standalone)
echo -e "${GREEN}[1/13] Publishing hypen-engine...${NC}"
cd "$ROOT_DIR/hypen-web/packages/web-engine/wasm-browser"
npm publish --access public $OTP
echo -e "${GREEN}✓ hypen-engine published${NC}"
echo ""

# 2. @hypen-space/core: every other @hypen-space package depends on it
echo -e "${GREEN}[2/13] Publishing @hypen-space/core...${NC}"
cd "$ROOT_DIR/hypen-web/packages/core"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/core published${NC}"
echo ""

# 3. @hypen-space/module-host: no @hypen-space/* deps. Before server, which
#    names it as an optional peer dependency (hosted WASM modules)
echo -e "${GREEN}[3/13] Publishing @hypen-space/module-host...${NC}"
cd "$ROOT_DIR/hypen-web/packages/module-host"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/module-host published${NC}"
echo ""

# 4. @hypen-space/web (core)
echo -e "${GREEN}[4/13] Publishing @hypen-space/web...${NC}"
cd "$ROOT_DIR/hypen-web/packages/web"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/web published${NC}"
echo ""

# 5. @hypen-space/server (core; optional peers web, module-host)
echo -e "${GREEN}[5/13] Publishing @hypen-space/server...${NC}"
cd "$ROOT_DIR/hypen-web/packages/server"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/server published${NC}"
echo ""

# 6. @hypen-space/web-engine (core, web)
echo -e "${GREEN}[6/13] Publishing @hypen-space/web-engine...${NC}"
cd "$ROOT_DIR/hypen-web/packages/web-engine"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/web-engine published${NC}"
echo ""

# 7. @hypen-space/device-web (core). Before cf, which depends on it
echo -e "${GREEN}[7/13] Publishing @hypen-space/device-web...${NC}"
cd "$ROOT_DIR/hypen-web/packages/device-web"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/device-web published${NC}"
echo ""

# 8. @hypen-space/device-fake (core)
echo -e "${GREEN}[8/13] Publishing @hypen-space/device-fake...${NC}"
cd "$ROOT_DIR/hypen-web/packages/device-fake"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/device-fake published${NC}"
echo ""

# 9. @hypen-space/agent (core)
echo -e "${GREEN}[9/13] Publishing @hypen-space/agent...${NC}"
cd "$ROOT_DIR/hypen-web/packages/agent"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/agent published${NC}"
echo ""

# 10. @hypen-space/cf (core, web, device-web)
echo -e "${GREEN}[10/13] Publishing @hypen-space/cf...${NC}"
cd "$ROOT_DIR/hypen-web/packages/cf"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/cf published${NC}"
echo ""

# 11. @hypen-space/lsp
echo -e "${GREEN}[11/13] Publishing @hypen-space/lsp...${NC}"
cd "$ROOT_DIR/hypen-lsp"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/lsp published${NC}"
echo ""

# 12. @hypen-space/cli (last: depends on this release's packages)
echo -e "${GREEN}[12/13] Publishing @hypen-space/cli...${NC}"
cd "$ROOT_DIR/hypen-cli"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/cli published${NC}"
echo ""

# 13. Publish @hypen-space/ios-streamer
#    Versioned independently from the rest of the train; failures here are
#    non-fatal (e.g. version already published, macOS-only publish host down).
echo -e "${GREEN}[13/13] Publishing @hypen-space/ios-streamer...${NC}"
cd "$ROOT_DIR/hypen-ios-streamer"
IOS_STREAMER_VERSION=$(node -p "require('./package.json').version")
if npm publish --access public $OTP; then
    echo -e "${GREEN}✓ @hypen-space/ios-streamer@${IOS_STREAMER_VERSION} published${NC}"
else
    echo -e "${YELLOW}⚠ @hypen-space/ios-streamer publish failed (ignored — independent release track)${NC}"
    echo -e "${YELLOW}  Likely: version ${IOS_STREAMER_VERSION} already on npm, or no version bump since last release.${NC}"
fi
echo ""

echo -e "${GREEN}✓ All npm packages published!${NC}"
echo ""
echo "Verify at:"
echo "  https://www.npmjs.com/package/hypen-engine"
echo "  https://www.npmjs.com/package/@hypen-space/core"
echo "  https://www.npmjs.com/package/@hypen-space/web"
echo "  https://www.npmjs.com/package/@hypen-space/server"
echo "  https://www.npmjs.com/package/@hypen-space/web-engine"
echo "  https://www.npmjs.com/package/@hypen-space/module-host"
echo "  https://www.npmjs.com/package/@hypen-space/device-web"
echo "  https://www.npmjs.com/package/@hypen-space/device-fake"
echo "  https://www.npmjs.com/package/@hypen-space/agent"
echo "  https://www.npmjs.com/package/@hypen-space/cf"
echo "  https://www.npmjs.com/package/@hypen-space/lsp"
echo "  https://www.npmjs.com/package/@hypen-space/cli"
echo "  https://www.npmjs.com/package/@hypen-space/ios-streamer"
