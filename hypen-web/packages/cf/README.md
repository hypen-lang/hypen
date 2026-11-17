# @hypen-space/cf

Run Hypen apps on Cloudflare Workers + Durable Objects: `defineHypenWorker`,
`HypenDurableObject`, `createCFEngine`, `durableObjectStore`, and a prebuilt
browser client (`@hypen-space/cf/client`). Full guide: the "Cloudflare" page
of the Hypen docs (`hypen-docs/content/docs/servers/cloudflare.mdx`).

```ts
import { defineHypenWorker } from "@hypen-space/cf/worker";
import { app } from "@hypen-space/core";

const module = app.defineState({ count: 0 })
  .onAction("inc", ({ state }) => { state.count += 1; })
  .ui(`module App { Text("@{state.count}") }`);

const worker = defineHypenWorker({ module, doClassName: "AppDO", binding: "APP_DO", serveClient: true });
export const AppDO = worker.AppDO;
export default { fetch: worker.fetch };
```

## Which Durable Object a client lands in

Each routing key is its own Durable Object (engine, storage, `.persist()`
state). `defineHypenWorker({ routing })`:

- `"visitor"` (default) — one DO per browser, keyed by an HttpOnly
  `hypen_visitor` cookie the worker sets on the first page response and on the
  first WebSocket 101 without it. Reloads, tabs and same-site `HypenApp`
  embeds share the visitor's DO. A cookieless `?sessionId=` client (native
  apps) is keyed by its session id. Tune with `visitorCookie: { name,
  maxAgeSeconds, sameSite }`.
- `"connection"` — `?sessionId=`, then a `hypen_session` cookie, then the URL
  path (`/room/abc` → `room:abc`), else a fresh DO. (The default of the
  lower-level `createWorkerHandler`.)
- `"shared"` — every client in one DO: deployment-wide state. Opt in.

A bare `/ws` is never a routing key, so connections without a session id do
not collapse into one DO unless you choose `"shared"`. `getRoutingKey`
overrides all of this. For a hand-written fetch handler the helpers are
exported: `readVisitorId`, `mintVisitorId`, `visitorRoutingKey`,
`withVisitorCookie`.

## Persistence

`.persist(durableObjectStore(strategy))` stores module state in the DO's own
storage. Every module instance of a DO's sessions writes through a store
bound to that DO's storage, so concurrent DOs of one class (which share an
isolate and a module definition) never write into each other.

A custom store built on a `durableObjectStore` (saving only some fields,
transforming the value on load) must stay per DO too. Build it with
`deriveStore(inner, wrap)`: `wrap` receives a store bound to one DO's storage
and returns the custom store over it, and the result implements the
`__forStorage` hook that `HypenDurableObject` uses to hand each DO its own
copy (memoised per storage, so state in `wrap`'s closure is per DO as well).

A custom store without `__forStorage` is not re-bound. Instead the DO runs
every call into it inside its own storage scope (`withStorageScope`), and a
`durableObjectStore` called inside that scope resolves to the scoping DO's
storage rather than the class-wide fallback. The scope uses
`AsyncLocalStorage` (the `nodejs_compat` flag) to follow the call across
`await`s; without it, only each call's synchronous prefix is scoped and the
DO warns once. State kept in such a wrapper's own closure is shared by every
DO of the class, which is another reason to prefer `deriveStore`.

## Building the browser client

`bun run build` bundles `client/generic-client.ts` (with `@hypen-space/web`
and `@hypen-space/core` from this workspace) into `dist/client/generic.js`
and runs `client/verify-bundle.ts`, which fails the build when the bundle is
missing renderer runtime (for example `clearChildren` patch support).
Always publish from a fresh build: the bundle is a snapshot of the renderer
at build time.
