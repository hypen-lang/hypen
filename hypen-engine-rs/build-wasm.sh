#!/bin/bash
set -e

echo "Building Hypen Engine for WASM..."

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "wasm-pack not found. Installing..."
    cargo install wasm-pack
fi

# ==============================================================================
# JavaScript Builds (wasm-bindgen)
# ==============================================================================

echo ""
echo "=== JavaScript Runtime Builds (wasm-bindgen) ==="
echo ""

# Build for web (bundler)
echo "Building for web (bundler)..."
wasm-pack build --target bundler --out-dir pkg/bundler --features js

# Build for node.js
echo "Building for Node.js..."
wasm-pack build --target nodejs --out-dir pkg/nodejs --features js

# Build for web (no bundler)
echo "Building for web (no bundler)..."
wasm-pack build --target web --out-dir pkg/web --features js

# Build for browser (alias for web, but keeps imports consistent)
echo "Building for browser..."
wasm-pack build --target web --out-dir pkg/browser --features js

# ==============================================================================
# WASI Build (C FFI)
# ==============================================================================

echo ""
echo "=== WASI Runtime Build (C FFI) ==="
echo ""

# Check if wasm32-wasip1 target is installed (was wasm32-wasi before Rust 1.78)
if ! rustup target list --installed | grep -q wasm32-wasip1; then
    echo "Installing wasm32-wasip1 target..."
    rustup target add wasm32-wasip1
fi

# Build for WASI
echo "Building for WASI..."
cargo build --target wasm32-wasip1 --release --features wasi

# Create output directory
mkdir -p pkg/wasi

# Copy the WASM file (target dir is at the workspace root, one level up)
WASI_WASM="../target/wasm32-wasip1/release/hypen_engine.wasm"
if [ ! -f "$WASI_WASM" ]; then
    # Fallback for non-workspace builds
    WASI_WASM="target/wasm32-wasip1/release/hypen_engine.wasm"
fi
cp "$WASI_WASM" pkg/wasi/

# Copy the WIT interface file
cp wit/hypen.wit pkg/wasi/

# Create a simple README for the WASI package
cat > pkg/wasi/README.md << 'EOF'
# Hypen Engine WASI Module

This is a WASI-compatible build of the Hypen Engine for use with non-JavaScript
WASM runtimes like Go (wasmtime-go, wazero), Python (wasmtime, wasmer), and others.

## Files

- `hypen_engine.wasm` - The WASM module with C FFI exports
- `hypen.wit` - WIT interface definition for Component Model support

## FFI Functions

All functions use a C-compatible ABI with string data passed as (ptr, len) pairs.
Data is exchanged as JSON strings.

### Memory Management
- `wasi_alloc(size) -> ptr` - Allocate memory
- `wasi_free(ptr, size)` - Free memory

### Lifecycle
- `hypen_init() -> status` - Initialize engine
- `hypen_destroy()` - Destroy engine
- `hypen_get_revision() -> u64` - Get revision number

### Rendering
- `hypen_render_source(source_ptr, source_len) -> status` - Render Hypen DSL
- `hypen_render_into(source_ptr, len, parent_ptr, len, state_ptr, len) -> status`

### State
- `hypen_update_state(patch_ptr, patch_len) -> status` - Update state
- `hypen_update_state_sparse(update_ptr, update_len) -> status` - Sparse update

### Module
- `hypen_set_module(config_ptr, config_len) -> status` - Set module config

### Actions
- `hypen_register_action(name_ptr, name_len) -> status` - Register action
- `hypen_dispatch_action(action_ptr, action_len) -> status` - Dispatch action

### Components
- `hypen_register_primitive(name_ptr, name_len) -> status` - Register primitive
- `hypen_register_component(name_ptr, len, source_ptr, len, path_ptr, len) -> status`

### Buffers (for retrieving results)
- `hypen_get_patches_len() -> usize` - Get patches buffer size
- `hypen_get_patches(out_ptr, out_len) -> bytes_copied` - Copy patches to buffer
- `hypen_clear_patches()` - Clear patches buffer
- `hypen_get_action_len() -> usize` - Get action buffer size
- `hypen_get_action(out_ptr, out_len) -> bytes_copied` - Copy action to buffer
- `hypen_clear_action()` - Clear action buffer

## Example (Go with wasmtime-go)

```go
// Load the WASM module
engine := wasmtime.NewEngine()
module, _ := wasmtime.NewModuleFromFile(engine, "hypen_engine.wasm")

// Create instance and call functions
// ... (see wasmtime-go documentation)
```

## Example (Python with wasmtime)

```python
from wasmtime import Store, Module, Instance

store = Store()
module = Module.from_file(store.engine, "hypen_engine.wasm")
instance = Instance(store, module, [])

# Get exports
init = instance.exports(store)["hypen_init"]
init(store)
```
EOF

echo ""
echo "=== Copying WASM to SDK locations ==="
echo ""

CORE_DIR="../hypen-web/packages/core"
SERVER_DIR="../hypen-web/packages/server"
WEB_ENGINE_DIR="../hypen-web/packages/web-engine"

# Copy Node.js build to server package wasm-node/
if [ -d "pkg/nodejs" ] && [ -d "$SERVER_DIR" ]; then
  mkdir -p "$SERVER_DIR/wasm-node"
  cp -r pkg/nodejs/* "$SERVER_DIR/wasm-node/"
  echo "  Copied pkg/nodejs/ -> $SERVER_DIR/wasm-node/"
fi

# Copy Web build to web-engine package wasm-browser/
if [ -d "pkg/web" ] && [ -d "$WEB_ENGINE_DIR" ]; then
  mkdir -p "$WEB_ENGINE_DIR/wasm-browser"
  cp -r pkg/web/* "$WEB_ENGINE_DIR/wasm-browser/"
  echo "  Copied pkg/web/ -> $WEB_ENGINE_DIR/wasm-browser/"
fi

# Legacy: also copy to core for backwards compatibility during transition
if [ -d "$CORE_DIR" ]; then
  if [ -d "pkg/nodejs" ] && [ -d "$CORE_DIR/wasm-node" ]; then
    cp -r pkg/nodejs/* "$CORE_DIR/wasm-node/"
    echo "  Copied pkg/nodejs/ -> $CORE_DIR/wasm-node/ (legacy)"
  fi
  if [ -d "pkg/web" ] && [ -d "$CORE_DIR/wasm-browser" ]; then
    cp -r pkg/web/* "$CORE_DIR/wasm-browser/"
    echo "  Copied pkg/web/ -> $CORE_DIR/wasm-browser/ (legacy)"
  fi
fi

# Copy WASI build to Go SDK (embedded via go:embed)
GO_SDK_DIR="../hypen-golang"
if [ -d "$GO_SDK_DIR" ] && [ -f "pkg/wasi/hypen_engine.wasm" ]; then
  cp pkg/wasi/hypen_engine.wasm "$GO_SDK_DIR/hypen_engine.wasm"
  echo "  Copied pkg/wasi/hypen_engine.wasm -> $GO_SDK_DIR/hypen_engine.wasm"
fi

echo ""
echo "=== Regenerating UniFFI bindings (Kotlin + Swift) ==="
echo ""

# UniFFI-generated Kotlin (hypen-kotlin/) and Swift (hypen-server-swift/)
# binding files must stay in lockstep with the Rust engine's
# `src/uniffi/mod.rs` enum/record shapes. Generating them here — right
# after the WASM rebuild — prevents the "stale binding" class of bugs
# where the engine emits e.g. a new Patch variant but a consumer SDK's
# enum converter blows up at runtime with "invalid enum value, something
# is very wrong". (That's exactly what a missing DETACH/ATTACH did to
# the Kotlin server on every nav.)
#
# Opt out by exporting `HYPEN_SKIP_BINDINGS=1` when iterating on JS-only
# changes — it's the one slow step in this script (~30s release build).
if [ "${HYPEN_SKIP_BINDINGS:-0}" = "1" ]; then
  echo "  (skipped — HYPEN_SKIP_BINDINGS=1)"
else
  GEN_SCRIPT="../scripts/generate-bindings.sh"
  if [ -f "$GEN_SCRIPT" ]; then
    bash "$GEN_SCRIPT"
  else
    echo "  (skipped — $GEN_SCRIPT not found; running outside the monorepo?)"
  fi
fi

echo ""
echo "=== Build Complete ==="
echo ""
echo "JavaScript builds (wasm-bindgen):"
echo "  - Bundler: pkg/bundler/"
echo "  - Node.js: pkg/nodejs/"
echo "  - Web: pkg/web/"
echo "  - Browser: pkg/browser/"
echo ""
echo "WASI build (C FFI):"
echo "  - WASI: pkg/wasi/"
echo "    - hypen_engine.wasm (WASM module)"
echo "    - hypen.wit (WIT interface definition)"
echo ""
echo "Native bindings (UniFFI):"
echo "  - Kotlin: ../hypen-kotlin/src/main/kotlin/uniffi/hypen_engine/"
echo "  - Swift:  ../hypen-server-swift/Sources/HypenEngine/"
echo "    (set HYPEN_SKIP_BINDINGS=1 to bypass on JS-only iterations)"
echo ""
