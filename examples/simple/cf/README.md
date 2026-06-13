# Hypen Simple — Cloudflare (one file)

The smallest possible Hypen-on-Cloudflare app: an inline counter and a
two-route Router, **entirely in `src/worker.ts`**. No `do.ts`, no `engine.ts`,
no wasm wiring, no component files — `defineHypenWorker` (from
`@hypen-space/cf/worker`) builds the Durable Object + engine (and imports the
WASM itself) from the inline module.

```bash
bun install
bun run dev          # wrangler dev → http://localhost:8787
```

Open `http://localhost:8787` in a browser — the worker serves a DOM-renderer
client at `/` that connects back to its own `/ws`. (Or point any other Hypen
client — Canvas, desktop, iOS — at `ws://localhost:8787/ws`.)

## What's where

The whole app is `src/worker.ts`:

- the module (`app.defineState(...).onAction(...).ui(...)`) — state, an action,
  and an inline `Router { Route ... }` template;
- one `defineHypenWorker({ module, doClassName, binding })` call;
- re-export the DO under the `wrangler.jsonc` `class_name`, and
  `export default { fetch }`.

`@hypen-space/cf/worker` imports the engine WASM for you. (If you need to pin
or supply your own engine build, import `defineHypenWorker` from the package
root `@hypen-space/cf` instead and pass `{ wasm, wasmModule }`.)

For a larger app (multiple route modules, external `.hypen` files, SVG
resources, a database), see the `calorie-counter/cloudflare` and
`social/cloudflare` examples.
