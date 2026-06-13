# Hypen Social — Cloudflare Worker + Durable Object

CF port of `../typescript/`. Same `queries.ts` and `module.ts` source,
running inside a Durable Object with DO SQLite replacing `bun:sqlite`.

## Architecture

Same as `../../calorie-counter/cloudflare`, with the addition that the
component templates live in standalone `src/components/*.hypen` files
(bundled via wrangler's `Text` rule and mapped to module names in
`src/templates.ts`).

## Run locally

```bash
bun install
bun run dev           # wrangler dev on http://localhost:8787
```

Connect a DOM or Canvas client to `ws://localhost:8787/ws`.

## Deploy

```bash
bunx wrangler login
bun run deploy
```

## Notable port adjustments

- `src/module.ts` was copied verbatim from
  `../typescript/server/module.ts` with one change: the top-level
  `const allExplorePosts = getExplorePosts()` was made lazy (a memoised
  getter). The DO's `db` shim isn't bound until the DO constructor
  runs, so any SQL call at worker module-load time would crash with a
  "DO SQLite not bound" error.
- `tsconfig.json` disables `strictNullChecks` to accept the pre-existing
  `action.payload` narrowing gaps in the source file.
