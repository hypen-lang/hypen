#!/usr/bin/env bash
# Overlay this checkout's engine + @hypen-space builds onto THIS example's
# node_modules — the same thing `scripts/dev-examples.sh --local` does for
# the examples in its list, for running Photos on its own.
#
# The device plane (camera, imports, downloads) needs an engine web build
# with the device broker; the published hypen-engine has none, so without
# this the worker logs "Device plane off" and the capture buttons report
# "This device can't take photos."
#
#   ENGINE_WEB=<dir with hypen_engine.js/.wasm>   default: hypen-engine-rs/pkg/web
#   WEB_DIR=<hypen-web checkout with built dists>  default: hypen-web
#
# Build them first:
#   (cd hypen-engine-rs && ./build-wasm.sh)
#   (cd hypen-web && bun install && bun run build:core && bun run build:web \
#      && bun run build:device-web && cd packages/cf && bun run build)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ENGINE_WEB="${ENGINE_WEB:-$ROOT/hypen-engine-rs/pkg/web}"
WEB_DIR="${WEB_DIR:-$ROOT/hypen-web}"

[[ -f "$ENGINE_WEB/hypen_engine.js" ]] || { echo "No engine web build at $ENGINE_WEB" >&2; exit 1; }
grep -q WasmDeviceBroker "$ENGINE_WEB/hypen_engine.js" || { echo "$ENGINE_WEB lacks the device broker (build with --features js,device-broker)" >&2; exit 1; }
[[ -f "$WEB_DIR/packages/cf/dist/client/generic.js" ]] || { echo "No built hypen-web dists under $WEB_DIR" >&2; exit 1; }

cd "$HERE"
[[ -d node_modules ]] || bun install --silent

# Engine: keep the published package.json (name/main), swap the code.
cp "$ENGINE_WEB"/hypen_engine.js "$ENGINE_WEB"/hypen_engine_bg.wasm "$ENGINE_WEB"/hypen_engine.d.ts node_modules/hypen-engine/

for short in core web cf; do
  src="$WEB_DIR/packages/$short"
  dest="node_modules/@hypen-space/$short"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "$src/package.json" "$dest/"
  cp -rL "$src/dist" "$dest/dist"
  [[ -d "$src/src" ]] && cp -rL "$src/src" "$dest/src"
  [[ -d "$src/client" ]] && cp -rL "$src/client" "$dest/client"
done
touch node_modules/.hypen-local-overlay

# wrangler dev's ProxyWorker ignores `no_web_socket_compression` (it is
# pinned to an old compatibility date); without the flag browsers refuse the
# device plane. Same patch as scripts/dev-examples.sh.
cli=node_modules/wrangler/wrangler-dist/cli.js
if [[ -f "$cli" ]] && grep -q 'compatibilityDate: "2023-12-18",' "$cli"; then
  perl -0777 -pi -e 's/(compatibilityDate: "2023-12-18",\s*compatibilityFlags: \["nodejs_compat")\]/$1, "no_web_socket_compression"]/g' "$cli"
fi

echo "Overlaid local engine ($ENGINE_WEB) and @hypen-space/{core,web,cf} ($WEB_DIR)."
