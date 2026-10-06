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

# Server-side JS builds carry the device broker (RFC 001: `WasmDeviceBroker`
# + `device*` helpers) via the `device-broker` feature: Node/Bun
# (@hypen-space/server) and Cloudflare (@hypen-space/cf, which imports the
# web-target `hypen-engine` package from pkg/web). The browser bundle
# (pkg/browser -> @hypen-space/web-engine) never brokers device requests and
# is built with `js` alone, keeping the broker, SHA-256 and the device payload
# validators (~0.5 MB raw) out of what browsers download.

# Build for web (bundler)
echo "Building for web (bundler)..."
wasm-pack build --target bundler --out-dir pkg/bundler --features js,device-broker

# Build for node.js
echo "Building for Node.js..."
wasm-pack build --target nodejs --out-dir pkg/nodejs --features js,device-broker

# Build for web (no bundler; Cloudflare Workers / Durable Objects)
echo "Building for web (no bundler, with device broker)..."
wasm-pack build --target web --out-dir pkg/web --features js,device-broker

# Build for browser (web target, no device broker)
echo "Building for browser (no device broker)..."
wasm-pack build --target web --out-dir pkg/browser --features js
if grep -q "WasmDeviceBroker" pkg/browser/hypen_engine.d.ts; then
  echo "error: the browser build must not include the device broker" >&2
  exit 1
fi

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

### Device broker (RFC 001) — `hypen_device_*`
Handle-based sans-IO broker; JSON shapes are documented in
`src/wasm/device_binding.rs`, ABI conventions in `src/wasm/wasi_device.rs`.
Statuses: 0 ok, 1/0 booleans, -1 "none" for i64 answers, errors <= -2
(-2 unknown handle, -3 bad pointer/UTF-8, -4 bad JSON); error text via
`hypen_device_last_error_len` / `hypen_device_last_error`.
- `hypen_device_result_len()` / `hypen_device_result(out, len)` - read the last result body
- `hypen_device_pool_create(limit) -> handle`, `hypen_device_pool_destroy`, `hypen_device_pool_in_use`
- `hypen_device_broker_create(cfg_ptr, cfg_len, pool, now_ms) -> handle (0 = error)`, `hypen_device_broker_destroy`
- `hypen_device_broker_start(h, now)`, `hypen_device_broker_open(h, spec, spec_len, dl, dl_len, has_dl, now)` - result `{"id"}` or `{"error"}`
- `hypen_device_broker_on_text(h, ptr, len, now)`, `hypen_device_broker_on_frame(h, ptr, len, now)`
- `hypen_device_broker_tick(h, now) -> next deadline | -1`, `hypen_device_broker_poll(h)` - result framed
  `[u32 LE header_len][JSON array of outputs][payload bytes]`, byte runs referenced by `offset`/`len`
- cancel / release_result / consumed_events / consumed_data / owner_activated / owner_deactivated /
  owner_destroyed / report_violation / set_transport_buffered / close / reopen_core / info / queries
- `hypen_device_broker_revision(h, cap, cap_len, version)` - effective revision JSON (or `null`)
- `hypen_device_server_consumes(rev, rev_len) -> 1 | 0` - does a broker-backed server consume that revision
- `hypen_device_handshake(hello, len, binary, caps, caps_len)` - validation + selection: `{"ack"}` or `{"ack": null, "reason"}`
- `hypen_device_negotiate`, `hypen_device_select_ack`, `hypen_device_validate_hello`,
  `hypen_device_validate_ack`, `hypen_device_server_advertisement`, `hypen_device_constants`,
  `hypen_device_is_oversize_text`, `hypen_device_file_save_params`, `hypen_device_sha256_hex`

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


# Copy every build output to where its SDK loads it (shared with CI).
bash "$(dirname "${BASH_SOURCE[0]}")/copy-wasm-artifacts.sh"
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
echo "  - Web: pkg/web/ (with device broker; Cloudflare)"
echo "  - Browser: pkg/browser/ (no device broker)"
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
