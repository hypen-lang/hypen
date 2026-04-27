#!/bin/bash
set -e

# Publish npm packages
# Order matters: core -> web -> server -> web-engine -> lsp -> cli

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

# 1. Publish @hypen-space/core
echo -e "${GREEN}[1/7] Publishing @hypen-space/core...${NC}"
cd "$ROOT_DIR/hypen-web/packages/core"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/core published${NC}"
echo ""

# 2. Publish @hypen-space/web
echo -e "${GREEN}[2/7] Publishing @hypen-space/web...${NC}"
cd "$ROOT_DIR/hypen-web/packages/web"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/web published${NC}"
echo ""

# 3. Publish @hypen-space/server
echo -e "${GREEN}[3/7] Publishing @hypen-space/server...${NC}"
cd "$ROOT_DIR/hypen-web/packages/server"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/server published${NC}"
echo ""

# 4. Publish @hypen-space/web-engine
echo -e "${GREEN}[4/7] Publishing @hypen-space/web-engine...${NC}"
cd "$ROOT_DIR/hypen-web/packages/web-engine"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/web-engine published${NC}"
echo ""

# 5. Publish @hypen-space/lsp
echo -e "${GREEN}[5/7] Publishing @hypen-space/lsp...${NC}"
cd "$ROOT_DIR/hypen-lsp"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/lsp published${NC}"
echo ""

# 6. Publish @hypen-space/cli
echo -e "${GREEN}[6/7] Publishing @hypen-space/cli...${NC}"
cd "$ROOT_DIR/hypen-cli"
npm publish --access public $OTP
echo -e "${GREEN}✓ @hypen-space/cli published${NC}"
echo ""

# 7. Publish @hypen-space/ios-streamer
#    Versioned independently from the rest of the train; failures here are
#    non-fatal (e.g. version already published, macOS-only publish host down).
echo -e "${GREEN}[7/7] Publishing @hypen-space/ios-streamer...${NC}"
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
echo "  https://www.npmjs.com/package/@hypen-space/core"
echo "  https://www.npmjs.com/package/@hypen-space/web"
echo "  https://www.npmjs.com/package/@hypen-space/server"
echo "  https://www.npmjs.com/package/@hypen-space/web-engine"
echo "  https://www.npmjs.com/package/@hypen-space/lsp"
echo "  https://www.npmjs.com/package/@hypen-space/cli"
echo "  https://www.npmjs.com/package/@hypen-space/ios-streamer"
