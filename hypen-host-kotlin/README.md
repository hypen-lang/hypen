# hypen-host-kotlin

The **standalone module-host library** for Android and the JVM. This is the
piece that *runs* Hypen modules (WASM components) on-device; renderers stay
pure patch consumers and live elsewhere (`hypen-renderer-android`).

```
your app (Kotlin)
  └── HypenHost (this library)
        └── UniFFI → hypen-engine's DualHost (Rust, libhypen_engine.so)
              ├── WasmtimeHost        (hypen:module@0.1.0 — sync)
              └── WasmtimeHostAsync   (hypen:module@0.2.0 — CM-async)
```

## What you get

- **Both module ABIs behind one object** — `register()` sniffs whether the
  component targets v0.1 (sync) or v0.2 (async) and routes accordingly. TS
  and Go modules (v0.1) and async Rust modules (v0.2) mix freely.
- **The full capability contract** (declare → grant → enforce):
  `ModuleGrants(storage, reads, dispatches, http)` — an ungranted capability
  is absent at link time, so e.g. an http-importing module with
  `http = false` fails to instantiate.
- **Persistent storage** — pass `HostConfig(dataDir = ...)` (e.g. under
  `context.filesDir`) and module `local`/`app` storage survives process
  restarts (atomic JSON snapshots).
- **`interpreter = true` (Pulley)** — runs modules with zero runtime
  codegen. Not needed on Android (JIT is allowed and faster); it exists for
  JIT-forbidden platforms and as the reference configuration the future
  Swift host library will use on iOS.

## Quick start

```kotlin
val host = HypenHost.create(HostConfig(dataDir = filesDir.resolve("hypen").path))
host.register(ModuleGrants("counter"), assets.open("counter.wasm").readBytes())
val id = host.instantiate("counter")
var state = host.init(id)
val out = host.dispatch(id, state, "increment")
state = out.state!!   // hand to the engine for re-render; apply out.effects
```

`dispatch` returns the shared wire shape every Hypen host emits
(`state`, `effects`, `emit`, `crossDispatch`, `subscribeRequests`) — the
same JSON the browser host and hypen-runtime produce, deserialized.

## Native library

The bindings load `libhypen_engine.so` via JNA. Build it from the workspace
root:

```bash
cargo build --release --features "uniffi,module-loader"
# Android ABIs (requires NDK toolchains):
cargo build --release --target aarch64-linux-android --features "uniffi,module-loader"
```

Regenerate bindings after changing the Rust surface:

```bash
cd hypen-engine-rs
cargo run --features "uniffi-cli,module-loader" --bin uniffi-bindgen -- \
    generate --library ../target/release/libhypen_engine.so \
    --language kotlin --out-dir ../hypen-host-kotlin/src/main/kotlin
```

## Tests

`gradle test` runs JVM integration tests against the real native library and
the real module fixtures — the exact code path an Android app takes. Note
for CI: the desktop `.so` must be built first (search path covers
`target/{release,debug}`).

## Relationship to hypen-kotlin

`hypen-kotlin` is the Kotlin **SDK** — the existing, unchanged path where
modules are written *in Kotlin* and run natively without WASM. This library
is additive: it hosts *WASM component* modules (built from TS/Rust/Go/…)
on-device. The two ship a copy of the same generated `uniffi.hypen_engine`
namespace; if an app ever needs both in one process, the generated bindings
should be consolidated into a shared artifact both depend on (tracked in
`wit/WASM_ENGINE_HANDOVER.md`).
