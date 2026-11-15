# Hypen WIT Spikes

Experimental code validating the v0.1 module/storage WIT specs in `wit/`.
Not part of the production engine or SDKs — these spikes exist to prove the
design works before we wire it into anything real.

## `stub-module/`

A minimal Hypen module in Rust that implements the `hypen:module` world.
Models a trivial counter: `increment` action bumps and persists to
`hypen:storage/local`, `sync` action pushes the value to `hypen:storage/cloud`
via `compare-and-set`.

```bash
cd stub-module
cargo build --target wasm32-wasip2 --release
# Output: target/wasm32-wasip2/release/hypen_stub_module.wasm  (~66 KB)
```

References `../../wit` so the canonical specs stay authoritative.

## `web-host/`

A JS host that loads the stub module via `jco transpile --instantiation`
and exercises the reducer + effect loop end-to-end. Two entry points share
one module: a Node CLI runner and an in-browser runner driven by Playwright.

```bash
cd web-host
bun install
bun run transpile         # WASM Component -> ES modules

bun run test:node         # Node runner, in-memory storage, prints to stdout
bun run test:browser      # Headless Chromium, localStorage-backed storage
bun run test              # Both
bun run serve             # Live dev server: http://localhost:3000
```

`test:browser` needs Playwright to know where Chromium is. By default it
looks in `~/.cache/ms-playwright/`; if you have a pre-installed build,
set `CHROMIUM_EXECUTABLE=/path/to/chrome` before the command. Otherwise
run `npx playwright install chromium` once.

Storage backends differ across the two runners:
- **Node runner** (`src/storage.mjs`): in-memory `Map`s. Resets on each run.
- **Browser runner** (`src/storage-browser.mjs`): `localStorage`-backed,
  base64-encoded bytes. State survives page reloads — proves the
  persistence claim in a real browser.

Production web hosts would swap `localStorage` for IndexedDB (or OPFS) and
`cloud` for a sync-service client; the WIT-facing wiring stays identical.
See `wit/V0_2_NOTES.md` §2 for why we're stuck on sync APIs until preview 3.

## What's been validated

- `wasm-tools component wit wit/` parses, resolves, encodes to binary.
- `wit-bindgen rust|go|c wit/` all generate cleanly.
- The Rust stub compiles to a 66 KB WASM Component for `wasm32-wasip2`.
- `jco transpile` converts the component to JS that imports `hypen:storage/*`
  exactly as named in the WIT.
- A JS host providing those imports as classes runs the full loop in both
  Node and headless Chromium: `init → dispatch(increment)×3 → dispatch(sync)
  → reload/warm-start → read back`. Browser version persists through
  full page reloads via `localStorage`.
- Effect descriptors (`log`) cross the boundary intact as
  `{ tag: 'log', val: { level, message } }`.
- Cloud `compare-and-set` versioning works (version 1 after first write).
