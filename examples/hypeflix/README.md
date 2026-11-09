# Hypeflix

A Netflix-style streaming app built with Hypen, showcasing the cross-platform
**Video component**. Every title is a public-domain (or freely licensed) film
streamed **directly from its public host** — the Internet Archive for the
classic feature films, Wikimedia Commons for the Blender open movies (Big Buck
Bunny, Sintel, Tears of Steel, …) — and the app server never proxies video
bytes.

```
examples/hypeflix/
└── cloudflare/
    ├── wrangler.jsonc          # Worker config (DO: HypeflixDO)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── worker.ts           # defineHypenWorker entry point
        ├── queries.ts          # catalog (archive.org + Wikimedia Commons) + stream resolution/validation
        ├── icons.ts            # inline SVG resources
        └── components/
            ├── App.ts          # Router shell (/, /movie/:id, /watch/:id)
            ├── Browse.ts       # Hero + marathon banner + genre rails + my list
            ├── MovieDetail.ts  # Poster, blurb, Play / My list
            └── Watch.ts        # Video player — the component showcase
```

## Run it

```bash
cd examples/hypeflix/cloudflare
bun install
bun run dev          # wrangler dev → http://localhost:8787 (or /canvas for the canvas renderer)
```

Deploy with `bunx wrangler login && bun run deploy`.

## What it shows off

- **`Video` component** (see `hypen-docs/content/docs/guide/components.mdx` for the full
  contract): single `src` playback with `controls`/`autoplay`/`poster`, and a
  `playlist` (the "Midnight Creature Marathon" plays three features
  back-to-back through one element, with `onTrackChange` keeping the UI in sync).
- **Stream-URL resolution, not payload proxying.** `queries.ts` resolves each
  archive.org title through the archive.org metadata API to a direct MP4
  derivative (`https://archive.org/download/<item>/<file>.mp4`, served with
  HTTP 206 range responses). The Blender open movies instead carry an ordered
  list of candidate URLs — Wikimedia Commons transcodes
  (`https://upload.wikimedia.org/wikipedia/commons/transcoded/…`), then
  mirrors/trailers as fallbacks — and the first one that validates wins. Either
  way only the resolved URL is sent to the client. (Some archive.org titles,
  e.g. Night of the Living Dead, also list a Commons copy as a fallback for
  when archive.org is slow.)
- **Failure modes.** Before playing, the server validates the resolved URL with
  a 1-byte ranged probe — e.g. archive.org answers 403 for access-restricted items
  and 404 for removed ones, and the Watch screen renders that as a structured
  error state ("Stream unavailable (HTTP 403)") instead of a dead player. If a
  stream dies *during* playback, the Video component reports it back through
  `onError` (with the HTTP status when the renderer can determine it), which
  lands in the same error UI.
- **Auth-protected streams** are supported by the component via the `headers`
  prop (e.g. `headers: {"Authorization": "Bearer …"}`); Hypeflix doesn't need
  it since its hosts are public, but the Watch screen's wiring is identical.

## Known limitations

- Navigation is server-driven (like the other examples), so deep-linking
  straight to `/watch/:id` in a fresh session lands on the persisted route
  (usually Browse); reach the player through the UI.
- archive.org derivative MP4s stream fine in every modern browser; a few very
  old items only carry `.ogv`, which the curation already filters out.

## About the movies

Most of the catalog is curated from the Internet Archive's
[Feature Films](https://archive.org/details/feature_films) collections —
films whose copyright has expired or was never renewed (His Girl Friday,
Night of the Living Dead, Nosferatu, Detour, …) plus freely licensed works
(Star Wreck). Each of those was verified against the metadata API for an
unrestricted, streamable MP4 derivative. The Blender Foundation's open movies
(Creative Commons licensed) stream from
[Wikimedia Commons](https://commons.wikimedia.org/) transcodes, with their
posters fetched through the worker's poster proxy from Commons too. Items can still be restricted or
removed later; that is precisely the failure mode the app demonstrates.
Please be a good citizen of the Archive — don't hammer it, and consider
[donating](https://archive.org/donate).
