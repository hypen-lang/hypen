# Hypen Calorie Counter — Cloudflare Worker + Durable Object

Runs the same module + component code as `../typescript/` but inside a
Cloudflare Worker, with a Durable Object replacing the Bun server and
DO SQLite (`state.storage.sql`) replacing `bun:sqlite`.

## Architecture

- **Worker** (`src/worker.ts`): the whole app. One
  `defineHypenWorker` (from `@hypen-space/cf/worker`) call wires the
  Durable Object, engine, WASM, WS routing, and `ManagedRouter`
  auto-wiring from the App template's `Router { Route(...) }` blocks.
  This file declares the App module + the route-module registry
  (Home/Diary/AddFood/Stats/Profile self-register via side-effect
  imports; BottomNav is passed as an anonymous fallback), and an
  `onStorage` hook that binds the DO's SQL into the `bun:sqlite` shim.
  No separate `do.ts` or `engine.ts` — `@hypen-space/cf/worker`
  provides all of it.
- **DB shim** (`src/db.ts`): drop-in for `bun:sqlite`'s
  `db.query(sql).all()/.get()/.run()` API on top of DO SQLite.
  Transactions go through `state.storage.transactionSync()` (DO SQLite
  rejects raw `SAVEPOINT`/`BEGIN`).
- **Seed** (`src/seed.ts`): runs `schema.sql` + bulk-inserts
  `foods.tsv` + runs `seed.sql` on first wake. Idempotent.

The `.sql` / `.tsv` files are pulled into the bundle via wrangler's
`Text` rule and the `.wasm` file via the `CompiledWasm` rule — there is
no filesystem inside a DO.

## Run locally

```bash
bun install
bun run dev           # wrangler dev, ready on http://localhost:8787
```

Connect a DOM or Canvas client to `ws://localhost:8787/ws` (the same
remote-UI protocol the typescript example speaks).

## Deploy

```bash
bunx wrangler login   # one-time
bun run deploy
```

## Storage: DO SQLite vs D1

Cloudflare gives you two SQL options, and the choice has a large blast
radius on a Hypen port. The short version: **this example uses DO SQLite,
and for a Hypen app reusing existing `bun:sqlite` query code, that's almost
always the right call.**

| | **DO SQLite** (`state.storage.sql`) | **D1** |
|---|---|---|
| API | **Synchronous** (`exec(...).toArray()`) | **Asynchronous** (`await db.prepare(...).all()`) |
| Locality | One DB **per Durable Object** — colocated with the session's compute | One DB shared across all Workers/DOs, separate from compute |
| `bun:sqlite` reuse | **Drop-in** — an ~80-line shim adapts the sync API; `queries.ts` and every handler are unchanged | **Rewrite** — every call site becomes `async/await`; the social example would be ~900 lines of churn |
| Best for | Per-session / per-room / per-user state, where one DO *is* the natural shard (chat rooms, documents, game lobbies, this calorie counter) | A single large dataset queried by many independent sessions that must all see the same rows |
| Migrations | You run `schema.sql` yourself on first wake (see `src/seed.ts`) | `wrangler d1 migrations` tooling |
| Transactions | `state.storage.transactionSync(() => ...)` (raw `BEGIN`/`SAVEPOINT` are rejected) | Implicit per-statement; batches via `db.batch([...])` |

### Why DO SQLite here

`queries.ts` is shared verbatim with the Bun/`bun:sqlite` example. Because
`bun:sqlite` is **synchronous**, the only sync SQL backend on CF — DO SQLite
— lets the entire query layer and every module handler move across
untouched (one `src/db.ts` shim does the adapting). Going to D1 would mean
rewriting every `getFoods()` / `addEntry()` into `async` and threading the
awaits up through the action handlers.

There is one shape change to watch for: **top-level DB calls crash at worker
module-load**, before the DO constructor binds the SQL backend. The social
example hit this with `const allExplorePosts = getExplorePosts()` at module
scope; the fix is to make such reads lazy (a memoised getter). DO SQLite
doesn't change that hazard, but it's where you'll first meet it.

### When to reach for D1 instead

If your data is one big shared table that many *unrelated* sessions read and
write (a global product catalog, a shared leaderboard) rather than
per-session state, a single D1 database is the better fit than trying to
funnel everyone through one Durable Object. Accept the async rewrite of your
query layer as the cost.

## Notes

- The whole worker is one `defineHypenWorker` call (`@hypen-space/cf/worker`).
  It hosts a core `RemoteSession` that owns the whole protocol (multi-module
  registration, component resolver, `ManagedRouter` auto-wiring, patch
  streaming) and imports the engine WASM itself. This example only declares
  the App module + registry + the `onStorage` hook for the DB shim. For a
  multi-module app that supplies its own engine build, or for porting Hypen to
  other runtimes, see `hypen-web/docs/implementing-an-engine.md`.
- DO SQLite is the synchronous backend (see "Storage" above) — chosen so
  `queries.ts` and every module handler move across from the `bun:sqlite`
  example unchanged.
- **Single core copy is required.** The `portable` helpers
  (`matchPath`, `diffState`) are a per-module-instance singleton in
  `@hypen-space/core`. `CFEngine` installs them; `RemoteSession` (inside
  `@hypen-space/cf`) consumes them. If the bundle resolves **two**
  physical copies of `@hypen-space/core` — one for the app, one nested
  under `@hypen-space/cf` — each gets its own singleton, only one is
  installed, and navigation fails at runtime with
  `Portable helper "matchPath" called before the engine was installed`
  (initial render still works — it's pure WASM). A clean
  `bun install` dedupes the `file:` workspace links onto one copy. If
  you see that error after editing core, `rm -rf node_modules bun.lock
  && bun install` in this example.
- Core is built with `splitting: true` (see
  `hypen-web/packages/core/build.ts`) so the `portable` impl singleton
  is shared across `dist/*.js` files instead of inlined per
  entrypoint. Without that fix, `setPortableImpl` only mutates one
  copy and `state.js` / `router.js` keep their `notInstalled`
  placeholders. **After changing core, rebuild it (`cd
  hypen-web/packages/core && bun run build`) and reinstall here** — the
  example bundles core's `dist`, not its `src`.
