#!/bin/bash
# Copy the wasm-pack / WASI build outputs in hypen-engine-rs/pkg/ to where
# each SDK loads them. build-wasm.sh runs this after building; CI jobs that
# download prebuilt pkg/ directories (typescript.yml, integration.yml,
# cross-platform.yml) run it too, so every job tests the engine built from
# the same source the same way:
#
#   pkg/nodejs  -> hypen-web/packages/server/wasm-node        (Node/Bun server)
#   pkg/web     -> hypen-web/tests/fixtures/wasm-web-glue      (Cloudflare glue + wasm SHA-256)
#   pkg/browser -> hypen-web/packages/web-engine/wasm-browser  (browser bundle)
#   pkg/wasi    -> hypen-golang/hypen_engine.wasm              (Go, go:embed)
#
# Only the pkg/ directories that exist are copied.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
echo ""
echo "=== Copying WASM to SDK locations ==="
echo ""

CORE_DIR="../hypen-web/packages/core"
SERVER_DIR="../hypen-web/packages/server"
WEB_ENGINE_DIR="../hypen-web/packages/web-engine"

# Copy a wasm-pack output directory into an SDK package. The destination's
# package.json is hand-maintained and tracked (e.g. wasm-node's
# `"type": "commonjs"` and `"sideEffects": false`, which wasm-pack does not
# emit), so it is kept and only its "version" is synced from the generated
# manifest; it is copied verbatim only when the destination has none.
copy_wasm_pkg() {
  local src="$1" dst="$2" f version
  mkdir -p "$dst"
  for f in "$src"/*; do
    [ "$(basename "$f")" = "package.json" ] && continue
    cp -r "$f" "$dst/"
  done
  if [ -f "$dst/package.json" ]; then
    version=$(sed -n -E 's/^[[:space:]]*"version":[[:space:]]*"([^"]*)".*/\1/p' "$src/package.json" | head -n 1)
    if [ -n "$version" ]; then
      sed -i.bak -E 's/^([[:space:]]*"version":[[:space:]]*")[^"]*(".*)$/\1'"$version"'\2/' "$dst/package.json"
      rm -f "$dst/package.json.bak"
    fi
  else
    cp "$src/package.json" "$dst/package.json"
  fi
}

# Copy Node.js build (with device broker) to server package wasm-node/
if [ -d "pkg/nodejs" ] && [ -d "$SERVER_DIR" ]; then
  copy_wasm_pkg pkg/nodejs "$SERVER_DIR/wasm-node"
  echo "  Copied pkg/nodejs/ -> $SERVER_DIR/wasm-node/"
fi

# Cloudflare's build (pkg/web) is consumed straight from pkg/ (untracked), so
# the web-target JS glue is copied into the hypen-web binding test's fixtures
# (tests/device-wasm-broker-binding.test.ts drives the broker through it)
# together with the SHA-256 of the wasm it was generated for. The web and
# nodejs targets build the same Rust with the same features, so that wasm is
# normally byte-identical to wasm-node's and the fixture reuses it; if it
# ever differs, the web wasm is copied into the fixture as well.
CF_GLUE_DIR="../hypen-web/tests/fixtures/wasm-web-glue"
if [ -d "pkg/web" ] && [ -d "../hypen-web/tests" ]; then
  mkdir -p "$CF_GLUE_DIR"
  cp pkg/web/hypen_engine.js "$CF_GLUE_DIR/hypen_engine.js"
  if command -v sha256sum &> /dev/null; then
    sha256sum pkg/web/hypen_engine_bg.wasm | cut -d' ' -f1 > "$CF_GLUE_DIR/hypen_engine_bg.wasm.sha256"
  else
    shasum -a 256 pkg/web/hypen_engine_bg.wasm | cut -d' ' -f1 > "$CF_GLUE_DIR/hypen_engine_bg.wasm.sha256"
  fi
  if cmp -s pkg/web/hypen_engine_bg.wasm "$SERVER_DIR/wasm-node/hypen_engine_bg.wasm"; then
    rm -f "$CF_GLUE_DIR/hypen_engine_bg.wasm"
  else
    cp pkg/web/hypen_engine_bg.wasm "$CF_GLUE_DIR/hypen_engine_bg.wasm"
  fi
  echo "  Copied pkg/web/ glue -> $CF_GLUE_DIR/"
fi

# Copy the browser build (no device broker) to web-engine package wasm-browser/
if [ -d "pkg/browser" ] && [ -d "$WEB_ENGINE_DIR" ]; then
  copy_wasm_pkg pkg/browser "$WEB_ENGINE_DIR/wasm-browser"
  echo "  Copied pkg/browser/ -> $WEB_ENGINE_DIR/wasm-browser/"
fi

# Legacy: also copy to core for backwards compatibility during transition
if [ -d "$CORE_DIR" ]; then
  if [ -d "pkg/nodejs" ] && [ -d "$CORE_DIR/wasm-node" ]; then
    copy_wasm_pkg pkg/nodejs "$CORE_DIR/wasm-node"
    echo "  Copied pkg/nodejs/ -> $CORE_DIR/wasm-node/ (legacy)"
  fi
  if [ -d "pkg/browser" ] && [ -d "$CORE_DIR/wasm-browser" ]; then
    copy_wasm_pkg pkg/browser "$CORE_DIR/wasm-browser"
    echo "  Copied pkg/browser/ -> $CORE_DIR/wasm-browser/ (legacy)"
  fi
fi

# Copy WASI build to Go SDK (embedded via go:embed)
GO_SDK_DIR="../hypen-golang"
if [ -d "$GO_SDK_DIR" ] && [ -f "pkg/wasi/hypen_engine.wasm" ]; then
  cp pkg/wasi/hypen_engine.wasm "$GO_SDK_DIR/hypen_engine.wasm"
  echo "  Copied pkg/wasi/hypen_engine.wasm -> $GO_SDK_DIR/hypen_engine.wasm"
fi

