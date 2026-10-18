---
name: run-examples
description: Run the Cloudflare example apps (examples/*) locally with wrangler dev — install, port map, the --local overlay for unreleased engine/SDK changes, expected warnings, and browser-verification recipe. Use when asked to run, preview, demo, or screenshot the example apps, or when wrangler dev fails with inspector "Address already in use" or logs "Device plane off".
---

# Running the Example Apps Locally

The examples under `examples/` are Cloudflare Workers built on
`@hypen-space/cf`. They depend on the **published** `@hypen-space/*` and
`hypen-engine` packages, so any single example runs from a fresh clone with
no WASM build and no `file:` links:

```bash
cd examples/todo/cloudflare
bun install
bun run dev                 # wrangler dev → http://localhost:8787
```

To run several at once (e.g. the home-screen launcher plus the apps it
embeds), use the script — it assigns the ports and inspector ports:

```bash
scripts/dev-examples.sh                  # launcher set: home-screen, todo, calculator
scripts/dev-examples.sh all              # every example
scripts/dev-examples.sh todo             # just one
scripts/dev-examples.sh --local ...      # overlay this checkout's engine + SDK builds
scripts/dev-examples.sh --local --fresh  # ...rebuilding the hypen-web dists first
```

Then open `http://localhost:8787` — the home-screen launcher embeds the
other examples via `HypenApp`, so you can tap through Todo and Calculator
from the phone UI. Logs go to `${TMPDIR:-/tmp}/hypen-dev-examples/<name>.log`.

## Port map

Ports are load-bearing: the launcher's `APPS` list
(`examples/home-screen/cloudflare/src/launcher.ts`, URLs built in
`src/endpoints.ts`) points each icon at `ws://localhost:<port>/ws` by
default. (Set `HYPEN_WORKERS_SUBDOMAIN` only for a deploy; it switches the
icons to `wss://<worker>.<subdomain>.workers.dev/ws`.)

| Example | Directory | Port | Launcher icon |
|---|---|---|---|
| home-screen | `examples/home-screen/cloudflare` | 8787 | (the launcher) |
| simple | `examples/simple/cf` | 8788 | — |
| todo | `examples/todo/cloudflare` | 8789 | Todo |
| calorie-counter | `examples/calorie-counter/cloudflare` | 8790 | Calories |
| movie-discovery | `examples/movie-discovery/cloudflare` | 8791 | MovieDB |
| food-ordering | `examples/food-ordering/cloudflare` | 8792 | Food |
| social | `examples/social/cloudflare` | 8793 | Social |
| calculator | `examples/calculator/cloudflare` | 8794 | Calculator |
| hypeflix | `examples/hypeflix/cloudflare` | 8795 | Hypeflix |

## Gotchas

1. **Concurrent `wrangler dev` instances collide on inspector port 9230.**
   Pass a distinct `--inspector-port` per instance or the second one dies
   with `Address already in use (127.0.0.1:9230)`. The script hands out
   9230, 9231, … (`HYPEN_EXAMPLES_INSPECTOR_BASE` moves the range).

2. **Expected `wrangler dev` warnings.** On the first connection the DO logs
   - `no allowedOrigins/authenticate configured — any client can connect` —
     fine locally; set them before deploying.
   - `Device plane off: no device broker: deviceWasm is missing or lacks
     WasmDeviceBroker … — sessions stay UI-only` — the installed
     `hypen-engine` web build has no device broker. Only
     `context.device.request(...)` features are affected (home-screen's Files
     uploads/downloads, social's media upload); every other screen works.
     Use `--local` (below) to get a broker-enabled engine.

3. **wrangler dev's ProxyWorker compresses WebSockets with context
   takeover.** It is pinned to compatibility date 2023-12-18, so it ignores
   the examples' `no_web_socket_compression` flag, and browsers then refuse
   the device plane (the console warns "device plane disabled on this
   connection"; uploads are unavailable). The script adds the flag to the
   installed wrangler's ProxyWorker (`patch_wrangler_proxy`). Deployed
   Workers take it from `wrangler.jsonc`.

4. **Testing unreleased engine/SDK changes (`--local`).** The script then
   overwrites each example's `node_modules/hypen-engine` with
   `hypen-engine-rs/pkg/web` (build it with `cd hypen-engine-rs &&
   ./build-wasm.sh`; the script refuses to start without it) and
   `@hypen-space/{core,web,cf}` with this checkout's dists (rebuilt when
   stale or with `--fresh`). Mixing a new engine with old published
   packages is a protocol mismatch, which is why all four are overlaid
   together. A later run without `--local` reinstalls the published
   packages. `food-ordering` is the exception: its `wrangler.jsonc` aliases
   `@hypen-space/core` and `@hypen-space/cf` to `hypen-web/packages/*/src`
   permanently.

Some examples need extra setup: movie-discovery reads `OMDB_API_KEY` from
`.dev.vars` (optional — it falls back to bundled titles), and the social and
home-screen examples bind R2 buckets (`MEDIA`, `FILES`). `wrangler dev`
emulates those under `.wrangler/state`; a deploy needs
`wrangler r2 bucket create` once per bucket (see each README).

To test the device plane headlessly: a picker is `page.waitForEvent("filechooser")`
after a trusted click on `[data-hypen-device="continue"]`; an OS file drop is
CDP `Input.dispatchDragEvent` with `data.files`. For `file.save`, delete
`window.showSaveFilePicker` in an init script so the `<a download>` fallback
runs.

Stopping: `wrangler dev` is `bunx` → node → workerd; killing only the
`bunx` PID can leave workerd holding the port. Start it with `setsid` and
kill the process group, or Ctrl-C the script (it stops every instance). If a
Durable Object's persisted state confuses testing, delete the example's
`.wrangler/` directory — but never while its server is running (wrangler
keeps its bundle temp files there).

## Verifying in a browser

Headless Chromium is preinstalled in CI/agent containers at
`/opt/pw-browsers/chromium`; drive it with Playwright (in those containers
it is installed globally — `require("/opt/node22/lib/node_modules/playwright")`
from a node script — otherwise `bunx playwright-core` / `import from
"playwright-core"`):

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
