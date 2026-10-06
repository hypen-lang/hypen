---
name: run-examples
description: Run the Cloudflare example apps (examples/*) locally with wrangler dev — WASM build, bun file:-symlink workaround, port map, and browser-verification recipe. Use when asked to run, preview, demo, or screenshot the example apps, or when wrangler dev fails with "Could not resolve hypen-engine" / inspector "Address already in use".
---

# Running the Example Apps Locally

The examples under `examples/` are Cloudflare Workers built on
`@hypen-space/cf`. They run locally with `wrangler dev`, but a fresh clone
needs three things lined up first. **Use the script — it handles all of
them:**

```bash
scripts/dev-examples.sh                  # launcher set: home-screen, simple, todo, calculator
scripts/dev-examples.sh all              # every example
scripts/dev-examples.sh todo             # just one
scripts/dev-examples.sh --fresh ...      # force-rebuild WASM + package dists
```

Then open `http://localhost:8787` — the home-screen launcher embeds the
other examples via `HypenApp`, so with the default set you can tap through
Counter, Todo, and Calculator from the phone UI.

## Port map

Ports are load-bearing: the launcher's `APPS` list
(`examples/home-screen/cloudflare/src/launcher.ts`) points at them.

| Example | Directory | Port |
|---|---|---|
| home-screen | `examples/home-screen/cloudflare` | 8787 |
| simple (Counter) | `examples/simple/cf` | 8788 |
| todo | `examples/todo/cloudflare` | 8789 |
| calorie-counter | `examples/calorie-counter/cloudflare` | 8790 |
| movie-discovery | `examples/movie-discovery/cloudflare` | 8791 |
| food-ordering | `examples/food-ordering/cloudflare` | 8792 |
| social | `examples/social/cloudflare` | 8793 |
| calculator | `examples/calculator/cloudflare` | 8794 |
| hypeflix | `examples/hypeflix/cloudflare` | 8795 |

## The three gotchas the script handles

If you run the steps by hand (or are debugging the script), these are the
failure modes:

1. **Build artifacts must exist first.** Examples depend on
   `hypen-engine: file:../../../hypen-engine-rs/pkg/web` — built by
   `wasm-pack build --target web --out-dir pkg/web --features js,device-broker` in
   `hypen-engine-rs/`. The `@hypen-space/*` packages also need their `dist/`
   built (`bun run build:core && bun run build:web` in `hypen-web/`, plus
   `bun run build` in `hypen-web/packages/cf`) because wrangler's esbuild
   resolves the `import` export condition, which points at `dist/`.

2. **bun `file:` deps are per-file symlink farms, and esbuild realpaths
   them.** Imports *inside* `@hypen-space/cf` (e.g. `import "hypen-engine"`)
   then re-resolve from the real `hypen-web/packages/cf/` path, where there
   is no `node_modules` — the build fails with
   `Could not resolve "hypen-engine"` (or an ENOENT for
   `hypen_engine_bg.wasm`). Fix: dereference the installed local packages
   into real copies (`cp -rL`) after `bun install`. This only affects local
   `file:` development; deployed/npm installs are unaffected.

3. **Concurrent `wrangler dev` instances collide on inspector port 9230.**
   Pass a distinct `--inspector-port` per instance or the second one dies
   with `Address already in use (127.0.0.1:9230)`.

4. **wrangler dev's ProxyWorker compresses WebSockets with context
   takeover.** It is pinned to compatibility date 2023-12-18, so it ignores
   the examples' `no_web_socket_compression` flag, and browsers then refuse
   the device plane (the console warns "device plane disabled on this
   connection"; uploads are unavailable). The script adds the flag to the
   installed wrangler's ProxyWorker (`patch_wrangler_proxy`). Deployed
   Workers take it from `wrangler.jsonc`.

The social and home-screen examples also bind R2 buckets (`MEDIA`,
`FILES`). `wrangler dev` emulates them under `.wrangler/state`; a deploy needs
`wrangler r2 bucket create` once per bucket (see each README).

To test the device plane headlessly: a picker is `page.waitForEvent("filechooser")`
after a trusted click on `[data-hypen-device="continue"]`; an OS file drop is
CDP `Input.dispatchDragEvent` with `data.files`. For `file.save`, delete
`window.showSaveFilePicker` in an init script so the `<a download>` fallback
runs.

Also: after rebuilding the engine WASM, refresh each example's
`node_modules/hypen-engine` copy (the script always re-copies it) and
restart wrangler. If a Durable Object's persisted state confuses testing,
delete the example's `.wrangler/` directory — but never while its server is
running (wrangler keeps its bundle temp files there).

## Verifying in a browser

Headless Chromium is preinstalled in CI/agent containers at
`/opt/pw-browsers/chromium`; drive it with `playwright-core`:

```ts
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
await page.goto("http://localhost:8787/");
await page.waitForSelector('text="Settings"');   // launcher rendered
await page.screenshot({ path: "home.png" });
```

Rendered elements carry `data-hypen-type` attributes (lowercased component
names) — useful for structural selectors, e.g.
`[data-hypen-type='hypenapp']` for embedded app frames.

## Deeper (renderer-less) verification

To exercise a template through the real engine without a browser, extract
the module's `.template` / `initialState` with bun (the packages resolve
from source via the `bun` export condition) and drive the native engine:
`parse_document` → `ast_to_ir_node` → `Engine::set_module` +
`set_render_callback` → `render_ir_node`, then `update_state` /
`update_state_sparse` and assert on the emitted patches. Watch for
`__Error` elements in Create patches — the engine renders misuse (e.g. a
static `Grid { }` without an array binding) as an `__Error` node rather
than failing loudly.
