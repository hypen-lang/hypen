#!/bin/bash
set -e

# Bump versions across all Hypen packages
# Usage: ./scripts/bump-versions.sh [patch|minor|major] or ./scripts/bump-versions.sh <rust-version> <npm-version>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Current versions (edit these as the source of truth)
CURRENT_RUST_VERSION="0.6.5"
CURRENT_NPM_VERSION="0.6.5"
CURRENT_LSP_VERSION="0.6.5"
CURRENT_GRADLE_VERSION="0.6.5"
CURRENT_SWIFT_SERVER_VERSION="0.6.5"
# @hypen-space/ios-streamer is versioned independently (macOS-only, optional
# CLI dep). Bump it via --ios-streamer <version>; otherwise it's left alone.
CURRENT_IOS_STREAMER_VERSION="0.1.0"

get_next_version() {
    local version=$1
    local bump_type=$2

    IFS='.' read -r major minor patch <<< "$version"

    case $bump_type in
        patch)
            echo "$major.$minor.$((patch + 1))"
            ;;
        minor)
            echo "$major.$((minor + 1)).0"
            ;;
        major)
            echo "$((major + 1)).0.0"
            ;;
        *)
            echo "$version"
            ;;
    esac
}

# Helper: update a dependency version in a package.json (with caret ^)
# Usage: update_dep <file> <package-name> <old-version> <new-version>
update_dep() {
    local file=$1 pkg=$2 old=$3 new=$4
    if [ -f "$file" ]; then
        sed -i '' "s/\"$pkg\": \"\^$old\"/\"$pkg\": \"^$new\"/" "$file"
    fi
}

# Helper: update a dependency version in a package.json (exact, no caret)
# Usage: update_dep_exact <file> <package-name> <old-version> <new-version>
update_dep_exact() {
    local file=$1 pkg=$2 old=$3 new=$4
    if [ -f "$file" ]; then
        sed -i '' "s/\"$pkg\": \"$old\"/\"$pkg\": \"$new\"/" "$file"
    fi
}

# Helper: update the "version" field in a package.json
# Usage: update_version <file> <old-version> <new-version>
update_version() {
    local file=$1 old=$2 new=$3
    if [ -f "$file" ]; then
        sed -i '' "s/\"version\": \"$old\"/\"version\": \"$new\"/" "$file"
    fi
}

# Parse optional --ios-streamer <version> flag; strip it from $@ before the
# positional arg handling below.
NEW_IOS_STREAMER_VERSION=""
POSITIONAL=()
while [ $# -gt 0 ]; do
    case "$1" in
        --ios-streamer)
            NEW_IOS_STREAMER_VERSION="$2"
            shift 2
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done
set -- "${POSITIONAL[@]}"

if [ $# -eq 1 ]; then
    BUMP_TYPE=$1
    NEW_RUST_VERSION=$(get_next_version "$CURRENT_RUST_VERSION" "$BUMP_TYPE")
    NEW_NPM_VERSION=$(get_next_version "$CURRENT_NPM_VERSION" "$BUMP_TYPE")
    NEW_LSP_VERSION="$NEW_NPM_VERSION"
    NEW_GRADLE_VERSION="$NEW_NPM_VERSION"
    NEW_SWIFT_SERVER_VERSION="$NEW_NPM_VERSION"
elif [ $# -eq 2 ]; then
    NEW_RUST_VERSION=$1
    NEW_NPM_VERSION=$2
    NEW_LSP_VERSION=$2
    NEW_GRADLE_VERSION=$2
    NEW_SWIFT_SERVER_VERSION=$2
else
    echo "Usage: $0 [patch|minor|major] [--ios-streamer <version>]"
    echo "   or: $0 <rust-version> <npm-version> [--ios-streamer <version>]"
    echo ""
    echo "Current versions:"
    echo "  Rust (parser, tailwind-parse, engine, server): $CURRENT_RUST_VERSION"
    echo "  NPM (core, web, server, web-engine, cf, cli, hypen-engine): $CURRENT_NPM_VERSION"
    echo "  NPM (lsp): $CURRENT_LSP_VERSION"
    echo "  Gradle (android, kotlin): $CURRENT_GRADLE_VERSION"
    echo "  Swift (hypen-server-swift): $CURRENT_SWIFT_SERVER_VERSION"
    echo "  NPM (ios-streamer, independent): $CURRENT_IOS_STREAMER_VERSION"
    exit 1
fi

echo -e "${YELLOW}Bumping versions:${NC}"
echo "  Rust:   $CURRENT_RUST_VERSION -> $NEW_RUST_VERSION"
echo "  NPM:    $CURRENT_NPM_VERSION -> $NEW_NPM_VERSION"
echo "  LSP:    $CURRENT_LSP_VERSION -> $NEW_LSP_VERSION"
echo "  Gradle: $CURRENT_GRADLE_VERSION -> $NEW_GRADLE_VERSION"
echo "  Swift (server): $CURRENT_SWIFT_SERVER_VERSION -> $NEW_SWIFT_SERVER_VERSION"
if [ -n "$NEW_IOS_STREAMER_VERSION" ]; then
    echo "  iOS Streamer: $CURRENT_IOS_STREAMER_VERSION -> $NEW_IOS_STREAMER_VERSION"
else
    echo "  iOS Streamer: $CURRENT_IOS_STREAMER_VERSION (unchanged — pass --ios-streamer <ver> to bump)"
fi
echo ""

# ── Rust crates ──────────────────────────────────────────────────────────

echo -e "${GREEN}Updating Rust crates...${NC}"

# Workspace root (parser, tailwind-parse, engine all inherit version from here)
sed -i '' "s/^version = \"$CURRENT_RUST_VERSION\"/version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/Cargo.toml"
echo "  ✓ Cargo.toml (workspace version)"

# hypen-engine (dependency versions need updating for crates.io)
sed -i '' "s/hypen-parser = { version = \"$CURRENT_RUST_VERSION\"/hypen-parser = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/hypen-engine-rs/Cargo.toml"
sed -i '' "s/hypen-tailwind-parse = { version = \"$CURRENT_RUST_VERSION\"/hypen-tailwind-parse = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/hypen-engine-rs/Cargo.toml"
echo "  ✓ hypen-engine-rs/Cargo.toml"

# hypen-sdk-rs (dependency versions need updating for crates.io)
sed -i '' "s/hypen-engine = { version = \"$CURRENT_RUST_VERSION\"/hypen-engine = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/hypen-sdk-rs/Cargo.toml"
sed -i '' "s/hypen-parser = { version = \"$CURRENT_RUST_VERSION\"/hypen-parser = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/hypen-sdk-rs/Cargo.toml"
echo "  ✓ hypen-sdk-rs/Cargo.toml"

# hypen-renderer-desktop + hypen-browser (path deps with crates.io version pins)
for crate in hypen-renderer-desktop hypen-browser; do
    sed -i '' "s/hypen-engine = { version = \"$CURRENT_RUST_VERSION\"/hypen-engine = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/$crate/Cargo.toml"
    sed -i '' "s/hypen-parser = { version = \"$CURRENT_RUST_VERSION\"/hypen-parser = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/$crate/Cargo.toml"
    sed -i '' "s/hypen-server = { version = \"$CURRENT_RUST_VERSION\"/hypen-server = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/$crate/Cargo.toml"
    sed -i '' "s/hypen-renderer-desktop = { version = \"$CURRENT_RUST_VERSION\"/hypen-renderer-desktop = { version = \"$NEW_RUST_VERSION\"/" "$ROOT_DIR/$crate/Cargo.toml"
    echo "  ✓ $crate/Cargo.toml"
done

# ── NPM packages (own versions + cross-deps) ────────────────────────────

echo -e "${GREEN}Updating NPM packages...${NC}"

OLD="$CURRENT_NPM_VERSION"
NEW="$NEW_NPM_VERSION"
OLD_LSP="$CURRENT_LSP_VERSION"
NEW_LSP="$NEW_LSP_VERSION"

# @hypen-space/core
update_version "$ROOT_DIR/hypen-web/packages/core/package.json" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/core/package.json"

# @hypen-space/web (depends on core)
update_version "$ROOT_DIR/hypen-web/packages/web/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/web/package.json" "@hypen-space\/core" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/web/package.json"

# @hypen-space/server (depends on core)
update_version "$ROOT_DIR/hypen-web/packages/server/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/server/package.json" "@hypen-space\/core" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/server/package.json"

# @hypen-space/web-engine (depends on core, web)
update_version "$ROOT_DIR/hypen-web/packages/web-engine/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/web-engine/package.json" "@hypen-space\/core" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/web-engine/package.json" "@hypen-space\/web" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/web-engine/package.json"

# @hypen-space/device-web (depends on core)
update_version "$ROOT_DIR/hypen-web/packages/device-web/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/device-web/package.json" "@hypen-space\/core" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/device-web/package.json"

# @hypen-space/device-fake (depends on core)
update_version "$ROOT_DIR/hypen-web/packages/device-fake/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/device-fake/package.json" "@hypen-space\/core" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/device-fake/package.json"

# @hypen-space/agent (depends on core)
update_version "$ROOT_DIR/hypen-web/packages/agent/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/agent/package.json" "@hypen-space\/core" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/agent/package.json"

# @hypen-space/cf (depends on core, web, device-web)
update_version "$ROOT_DIR/hypen-web/packages/cf/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/cf/package.json" "@hypen-space\/core" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/cf/package.json" "@hypen-space\/web" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-web/packages/cf/package.json" "@hypen-space\/device-web" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/cf/package.json"

# @hypen-space/lsp
update_version "$ROOT_DIR/hypen-lsp/package.json" "$OLD_LSP" "$NEW_LSP"
echo "  ✓ hypen-lsp/package.json"

# @hypen-space/cli (depends on core, web, server, web-engine, lsp)
update_version "$ROOT_DIR/hypen-cli/package.json" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/core" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/web" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/server" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/web-engine" "$OLD" "$NEW"
update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/lsp" "$OLD_LSP" "$NEW_LSP"
echo "  ✓ hypen-cli/package.json"

# ── WASM artifacts ───────────────────────────────────────────────────────

echo -e "${GREEN}Updating WASM artifacts...${NC}"

update_version "$ROOT_DIR/hypen-web/packages/server/wasm-node/package.json" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/server/wasm-node/package.json"

update_version "$ROOT_DIR/hypen-web/packages/web-engine/wasm-browser/package.json" "$OLD" "$NEW"
echo "  ✓ hypen-web/packages/web-engine/wasm-browser/package.json"

# ── Dependent packages ───────────────────────────────────────────────────

echo -e "${GREEN}Updating dependent packages...${NC}"

# hypen-web/example-bun (caret deps: core, server, web, web-engine)
for pkg in core server web web-engine; do
    update_dep "$ROOT_DIR/hypen-web/example-bun/package.json" "@hypen-space\/$pkg" "$OLD" "$NEW"
done
echo "  ✓ hypen-web/example-bun/package.json"

# hypen-cli/test-project (caret deps: core, server, web, web-engine, cli)
for pkg in core server web web-engine cli; do
    update_dep "$ROOT_DIR/hypen-cli/test-project/package.json" "@hypen-space\/$pkg" "$OLD" "$NEW"
done
echo "  ✓ hypen-cli/test-project/package.json"

# hypen-cli/test-studio-app (caret deps: core, server, web, web-engine, cli)
for pkg in core server web web-engine cli; do
    update_dep "$ROOT_DIR/hypen-cli/test-studio-app/package.json" "@hypen-space\/$pkg" "$OLD" "$NEW"
done
echo "  ✓ hypen-cli/test-studio-app/package.json"

# hypen-cli/studio-ui (exact versions, no caret: core, server, web, web-engine)
for pkg in core server web web-engine; do
    update_dep_exact "$ROOT_DIR/hypen-cli/studio-ui/package.json" "@hypen-space\/$pkg" "$OLD" "$NEW"
done
echo "  ✓ hypen-cli/studio-ui/package.json"

# Cloudflare examples (exact versions, no caret: core, cf, hypen-engine)
for dir in "$ROOT_DIR"/examples/*/cloudflare "$ROOT_DIR/examples/simple/cf"; do
    [ -f "$dir/package.json" ] || continue
    update_dep_exact "$dir/package.json" "@hypen-space\/core" "$OLD" "$NEW"
    update_dep_exact "$dir/package.json" "@hypen-space\/cf" "$OLD" "$NEW"
    update_dep_exact "$dir/package.json" "hypen-engine" "$OLD" "$NEW"
    echo "  ✓ ${dir#$ROOT_DIR/}/package.json"
done

# ── @hypen-space/ios-streamer (independent track, optional) ─────────────

if [ -n "$NEW_IOS_STREAMER_VERSION" ]; then
    echo -e "${GREEN}Updating @hypen-space/ios-streamer...${NC}"
    update_version "$ROOT_DIR/hypen-ios-streamer/package.json" \
        "$CURRENT_IOS_STREAMER_VERSION" "$NEW_IOS_STREAMER_VERSION"
    echo "  ✓ hypen-ios-streamer/package.json"

    # hypen-cli declares it as an optionalDependency — keep the caret range in sync.
    update_dep "$ROOT_DIR/hypen-cli/package.json" "@hypen-space\/ios-streamer" \
        "$CURRENT_IOS_STREAMER_VERSION" "$NEW_IOS_STREAMER_VERSION"
    echo "  ✓ hypen-cli/package.json (optionalDependencies)"
fi

# ── Gradle packages (Android + Kotlin) ──────────────────────────────────

echo -e "${GREEN}Updating Gradle packages...${NC}"

NEW_GRADLE="$NEW_GRADLE_VERSION"

# Match the top-level `version = "..."` line regardless of its current value —
# this way the bump still works if a Gradle file drifted out of sync with the
# npm/Rust packages. The pattern tolerates leading whitespace (the Android root
# sets version inside a `subprojects {}` block).
GRADLE_VERSION_SED='s/^([[:space:]]*)version[[:space:]]*=[[:space:]]*"[^"]*"/\1version = "'"$NEW_GRADLE"'"/'

# hypen-renderer-android (root build.gradle.kts sets version for all subprojects)
sed -i '' -E "$GRADLE_VERSION_SED" "$ROOT_DIR/hypen-renderer-android/build.gradle.kts"
echo "  ✓ hypen-renderer-android/build.gradle.kts"

# hypen-kotlin
sed -i '' -E "$GRADLE_VERSION_SED" "$ROOT_DIR/hypen-kotlin/build.gradle.kts"
echo "  ✓ hypen-kotlin/build.gradle.kts"

# ── Swift packages ──────────────────────────────────────────────────────

echo -e "${GREEN}Updating Swift packages...${NC}"

# hypen-server-swift exposes its version as a static constant in
# HypenServerVersion — bump the literal to keep it in sync with the release.
sed -i '' "s/public static let version = \"$CURRENT_SWIFT_SERVER_VERSION\"/public static let version = \"$NEW_SWIFT_SERVER_VERSION\"/" \
    "$ROOT_DIR/hypen-server-swift/Sources/HypenServer/HypenServer.swift"
echo "  ✓ hypen-server-swift/Sources/HypenServer/HypenServer.swift"

# ── Update this script's versions for next time ─────────────────────────

sed -i '' "s/CURRENT_RUST_VERSION=\"$CURRENT_RUST_VERSION\"/CURRENT_RUST_VERSION=\"$NEW_RUST_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
sed -i '' "s/CURRENT_NPM_VERSION=\"$CURRENT_NPM_VERSION\"/CURRENT_NPM_VERSION=\"$NEW_NPM_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
sed -i '' "s/CURRENT_LSP_VERSION=\"$CURRENT_LSP_VERSION\"/CURRENT_LSP_VERSION=\"$NEW_LSP_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
sed -i '' "s/CURRENT_GRADLE_VERSION=\"$CURRENT_GRADLE_VERSION\"/CURRENT_GRADLE_VERSION=\"$NEW_GRADLE_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
sed -i '' "s/CURRENT_SWIFT_SERVER_VERSION=\"$CURRENT_SWIFT_SERVER_VERSION\"/CURRENT_SWIFT_SERVER_VERSION=\"$NEW_SWIFT_SERVER_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
if [ -n "$NEW_IOS_STREAMER_VERSION" ]; then
    sed -i '' "s/CURRENT_IOS_STREAMER_VERSION=\"$CURRENT_IOS_STREAMER_VERSION\"/CURRENT_IOS_STREAMER_VERSION=\"$NEW_IOS_STREAMER_VERSION\"/" "$SCRIPT_DIR/bump-versions.sh"
fi

# ── Refresh bun lockfiles ───────────────────────────────────────────────
#
# Keep lockfiles in sync with the bumped package.jsons. Only dirs whose
# @hypen-space/* deps resolve locally (or have no @hypen-space deps) can be
# refreshed here — hypen-cli + studio-ui are refreshed by publish-all.sh
# *after* the SDKs are on npm.

echo ""
echo -e "${GREEN}Refreshing bun lockfiles...${NC}"

refresh_lock() {
    local dir=$1
    if [ ! -f "$dir/package.json" ]; then return; fi
    if (cd "$dir" && bun install --silent > /dev/null 2>&1); then
        echo "  ✓ $dir/bun.lock"
    else
        echo -e "  ${YELLOW}⚠ $dir/bun.lock (bun install failed — refresh manually)${NC}"
    fi
}

# hypen-web is a workspace — @hypen-space/* cross-deps resolve locally.
refresh_lock "$ROOT_DIR/hypen-web"
# hypen-lsp has no @hypen-space deps.
refresh_lock "$ROOT_DIR/hypen-lsp"
if [ -n "$NEW_IOS_STREAMER_VERSION" ]; then
    # ios-streamer has no @hypen-space deps.
    refresh_lock "$ROOT_DIR/hypen-ios-streamer"
fi

echo ""
echo -e "${GREEN}✓ All versions bumped!${NC}"
echo ""
echo "Next steps:"
echo "  1. Commit the version bump"
echo "  2. Create a PR to main with the 'Release' label"
echo "  3. Add 'publish:npm', 'publish:crates', etc. labels for each target"
echo "  4. Include 'Version: $NEW_NPM_VERSION' in the PR body"
echo "  5. Merge — the Release workflow handles the rest"
