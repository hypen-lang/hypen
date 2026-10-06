#!/usr/bin/env bash
# Device Capability Protocol cross-language end-to-end test (RFC 001):
# builds the Swift e2e server (HypenDeviceE2EServer: RemoteServer + the Rust
# device broker via UniFFI) and runs the TypeScript web client against it
# over a real WebSocket (bun test).
#
# Needs: the native engine library (cargo build --release --features uniffi
# in hypen-engine-rs → <repo>/target/release/libhypen_engine.so, or set
# HYPEN_ENGINE_LIB_DIR), a Swift 6 toolchain, bun, and `bun install` in
# hypen-web (the client packages are imported from source).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/../.." && pwd)"
repo="$(cd "$pkg/.." && pwd)"
lib="${HYPEN_ENGINE_LIB_DIR:-$repo/target/release}"

export LIBRARY_PATH="$lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
export LD_LIBRARY_PATH="$lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DYLD_LIBRARY_PATH="$lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

# Fail — never skip — when the TypeScript client cannot run.
if ! command -v bun >/dev/null 2>&1; then
  echo "device e2e: bun is not installed" >&2
  exit 1
fi
if [ ! -d "$repo/hypen-web/node_modules" ]; then
  echo "device e2e: run \`bun install\` in hypen-web first" >&2
  exit 1
fi
if [ ! -e "$lib/libhypen_engine.so" ] && [ ! -e "$lib/libhypen_engine.dylib" ]; then
  echo "device e2e: no native engine library in $lib (cargo build --release --features uniffi)" >&2
  exit 1
fi

cd "$pkg"
# Pass the library directory to the linker explicitly as well: Swift 6.4's
# build system does not forward LIBRARY_PATH to the link step on Linux.
swift build --product HypenDeviceE2EServer -Xlinker -L"$lib" "$@"
bin="$(swift build --product HypenDeviceE2EServer -Xlinker -L"$lib" --show-bin-path "$@")/HypenDeviceE2EServer"
HYPEN_DEVICE_E2E_SERVER="$bin" bun test ./Tests/DeviceE2E/device-e2e.test.ts
