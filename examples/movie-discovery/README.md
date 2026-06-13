# Movie Discovery — Hypen Example

A Cinebox-style movie discovery app backed by the
[OMDb API](https://www.omdbapi.com/). It shows off catalog browsing,
search filters, detail routes, poster imagery, and watchlist state.

## Structure

```
movie-discovery/
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
If no key is present, the example still boots with a small bundled
fallback so the UI is not blank.

## Screens

- **Home** — featured movie, trending rail, recommendations
- **Search** — query input, genre chips, result list
- **Movie Detail** — poster treatment, metadata, synopsis, cast, save action
- **Watchlist** — saved movies with remove actions
- **Profile** — user stats and saved-library summary

## Running

```bash
cd typescript
bun install

OMDB_API_KEY=your_key bun run dev
bun run web
```

Then open `http://localhost:3001`.
