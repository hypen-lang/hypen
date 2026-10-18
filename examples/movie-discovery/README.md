# Movie Discovery — Hypen Example

A Cinebox-style movie discovery app backed by the
[OMDb API](https://www.omdbapi.com/). It shows off catalog browsing,
search filters, detail routes, poster imagery, and watchlist state.

## Structure

```
movie-discovery/
├── cloudflare/                 # Same app as a Cloudflare Worker (wrangler dev)
└── typescript/
    ├── server/
    │   ├── index.ts
    │   ├── queries.ts          # OMDb fetches + curated home rails
    │   └── components/
    │       ├── App.ts
    │       ├── Home.ts
    │       ├── Search.ts
    │       ├── MovieDetail.ts
    │       ├── Watchlist.ts
    │       ├── Profile.ts
    │       └── BottomNav.ts
    └── web/
        ├── index.html
        ├── client.ts
        └── serve.ts
```

## Data

Set `OMDB_API_KEY` before starting the server to load live movie data:

```bash
OMDB_API_KEY=your_key bun run dev
```

The Home screen keeps a tiny curated list of IMDb IDs for its featured,
trending, and recommended rails, then hydrates those records from OMDb.
Search uses OMDb's `s` endpoint and opens detail routes with IMDb IDs.
If no key is present, or OMDb rejects the request (bad key, rate limit,
network error), the example falls back to a small bundled catalog so the
UI is never blank.

## Screens

- **Home** — featured movie, trending rail, recommendations
- **Search** — query input, genre chips, result list
- **Movie Detail** — poster treatment, metadata, synopsis, cast, save action
- **Watchlist** — saved movies with remove actions
- **Profile** — user stats and saved-library summary

## Running

### TypeScript server + web client

```bash
cd typescript
bun run setup        # installs hypen-web's deps + this example's (see note)

OMDB_API_KEY=your_key bun run dev   # WebSocket server on :3000 (PORT=... to change)
bun run web                         # web client on :3001 (WEB_PORT=... to change)
```

Then open `http://localhost:3001`. The client connects to the server's
`PORT` on the page's host (`serve.ts` injects it; `WS_URL=...` overrides it),
and `?ws=ws://host:port` in the page URL overrides both.

> **First run:** the `@hypen-space/*` dependencies are `file:` links into
> this repo's `hypen-web/packages/*`, and those packages resolve their own
> dependencies (e.g. `@chenglou/pretext` for the web renderer) from
> `hypen-web/node_modules`. `bun run setup` installs both in one go
> (equivalent to `cd ../../../hypen-web && bun install`, then `bun install`
> here). Skipping it fails the web build with
> `Could not resolve: "@chenglou/pretext"`.

### Cloudflare Worker

```bash
cd cloudflare
bun install
cp .dev.vars.example .dev.vars   # optional: add your OMDB_API_KEY
bun run dev                      # wrangler dev on :8787 (add -- --port N to change)
```

Then open `http://localhost:8787`. No key is committed: without one the
Worker quietly serves the bundled fallback titles. If a key is set but OMDb
rejects it, rate-limits, or is unreachable, the Worker logs a single
`OMDb unavailable` warning and falls back to the same titles. For a deploy,
use `bunx wrangler secret put OMDB_API_KEY`.

`wrangler dev` may log `Device plane off: no device broker: deviceWasm is
missing or lacks WasmDeviceBroker … — sessions stay UI-only`. That is
harmless here: the device plane only backs `context.device.request(...)`
(file pickers, camera, …), which this example doesn't use; the UI works the
same. It appears when the installed `hypen-engine` web build was compiled
without the `device-broker` feature.
