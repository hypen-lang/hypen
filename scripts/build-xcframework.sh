#!/bin/bash
set -euo pipefail

# Build hypen_engineFFI.xcframework from the Rust engine for every Apple
# target Swift consumers care about, lipo'ing the same-platform slices
# into universal libs and packaging the result as a single .xcframework.
#
# Output: hypen-server-swift/hypen_engineFFI.xcframework
#
# This is the artifact `Package.swift` ships as a `.binaryTarget`. CI
# uploads it to a GitHub release and writes the URL + checksum back into
# `Package.swift` before tagging.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$ROOT_DIR/hypen-engine-rs"
SWIFT_DIR="$ROOT_DIR/hypen-server-swift"

LIB_NAME="hypen_engine"
ARCHIVE="lib${LIB_NAME}.a"
HEADER_SRC="$SWIFT_DIR/Sources/hypen_engineFFI/hypen_engineFFI.h"

OUT_DIR="$ROOT_DIR/target/xcframework-build"
XCF_PATH="$SWIFT_DIR/hypen_engineFFI.xcframework"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# ─────────────────────────────────────────────────────────────────────
# 1. Build static libs for every target (uniffi feature is required —
#    that's what generates the FFI symbols Swift binds to).
# ─────────────────────────────────────────────────────────────────────

TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  aarch64-apple-ios
  aarch64-apple-ios-sim
  x86_64-apple-ios
)

cd "$ENGINE_DIR"
for t in "${TARGETS[@]}"; do
  echo -e "${GREEN}[xcframework]${NC} cargo build --release --features uniffi --target $t"
  cargo build --release --features uniffi --target "$t"
done

# ─────────────────────────────────────────────────────────────────────
# 2. lipo same-platform slices together. xcframework wants ONE archive
#    per slice; both architectures of macOS go in one slice, both
#    architectures of the iOS simulator go in another, and iOS device
#    is single-arch.
# ─────────────────────────────────────────────────────────────────────

mkdir -p "$OUT_DIR/macos" "$OUT_DIR/ios" "$OUT_DIR/ios-sim"

echo -e "${GREEN}[xcframework]${NC} lipo macOS universal"
lipo -create \
  "$ROOT_DIR/target/aarch64-apple-darwin/release/${ARCHIVE}" \
  "$ROOT_DIR/target/x86_64-apple-darwin/release/${ARCHIVE}" \
  -output "$OUT_DIR/macos/${ARCHIVE}"

echo -e "${GREEN}[xcframework]${NC} lipo iOS-simulator universal"
lipo -create \
  "$ROOT_DIR/target/aarch64-apple-ios-sim/release/${ARCHIVE}" \
  "$ROOT_DIR/target/x86_64-apple-ios/release/${ARCHIVE}" \
  -output "$OUT_DIR/ios-sim/${ARCHIVE}"

cp "$ROOT_DIR/target/aarch64-apple-ios/release/${ARCHIVE}" \
   "$OUT_DIR/ios/${ARCHIVE}"

# ─────────────────────────────────────────────────────────────────────
# 3. Stage headers + module map per slice. xcframework discovers the
#    module via the modulemap inside the slice's Headers dir.
# ─────────────────────────────────────────────────────────────────────

for slice in macos ios ios-sim; do
  hdr_dir="$OUT_DIR/$slice/Headers"
  mkdir -p "$hdr_dir"
  cp "$HEADER_SRC" "$hdr_dir/"
  cat > "$hdr_dir/module.modulemap" <<EOF
module hypen_engineFFI {
    header "hypen_engineFFI.h"
    export *
}
EOF
done

# ─────────────────────────────────────────────────────────────────────
# 4. Pack the xcframework. -create-xcframework is fussy about already-
#    existing output dirs, so blow it away first.
# ─────────────────────────────────────────────────────────────────────

rm -rf "$XCF_PATH"

echo -e "${GREEN}[xcframework]${NC} xcodebuild -create-xcframework"
xcodebuild -create-xcframework \
  -library "$OUT_DIR/macos/${ARCHIVE}"   -headers "$OUT_DIR/macos/Headers" \
  -library "$OUT_DIR/ios/${ARCHIVE}"     -headers "$OUT_DIR/ios/Headers" \
  -library "$OUT_DIR/ios-sim/${ARCHIVE}" -headers "$OUT_DIR/ios-sim/Headers" \
  -output "$XCF_PATH"

echo ""
echo -e "${GREEN}✓ Built $XCF_PATH${NC}"
echo "  Slices: macos (arm64+x86_64), ios-arm64, ios-sim (arm64+x86_64)"
