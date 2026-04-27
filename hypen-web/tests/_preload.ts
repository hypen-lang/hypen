/**
 * Test preload: installs the engine-backed portable implementation into
 * `@hypen-space/core` before any test runs. Without this, the state /
 * router / path / URL helpers in core would throw "portable helper not
 * installed", because core itself is WASM-free by design — it relies on
 * server or web-engine to plug in the canonical Rust engine impls.
 *
 * Referenced from `bunfig.toml` via the `[test] preload` key.
 */
import "../packages/server/src/install-portable.ts";
