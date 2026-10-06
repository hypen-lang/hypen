# Home Screen — Hypen Example

A phone-style **home screen that launches other Hypen apps**. The launcher is
itself a Hypen app; each icon opens a full-screen frame whose body is a single
built-in `HypenApp("<ws-url>")` component, which connects to a remote Hypen
app over WebSocket and renders it inline. Every example in this repo deploys
as a Cloudflare Worker, so "installing an app" is literally just a URL.

```
home-screen/
└── cloudflare/
    ├── src/
    │   ├── launcher.ts    # APPS list + generated home-screen DSL + module
    │   ├── unsplash.ts    # wallpaper photos + the per-breakpoint crop ladder
    │   ├── geo.ts         # request.cf geo + Open-Meteo weather
    │   └── worker.ts      # defineHypenWorker wiring
    ├── wrangler.jsonc
    ├── package.json
    └── tsconfig.json
```

## Run it (locally, with the sibling examples)

The easy way — from the repo root:

```bash
scripts/dev-examples.sh        # launcher + simple + todo + calculator
scripts/dev-examples.sh all    # every example
```

It builds the engine WASM and package dists if missing, installs each
example, works around bun's `file:`-symlink/esbuild issue, assigns the
ports below, and gives each instance its own inspector port.

Or by hand: each embedded app is a separate worker, so give each its own
port. In separate terminals (`bun install` once in each directory first):

```bash
cd examples/home-screen/cloudflare     && bun run dev                # :8787 — the launcher
cd examples/simple/cf                  && wrangler dev --port 8788   # Counter
cd examples/todo/cloudflare            && wrangler dev --port 8789   # Todo
cd examples/calorie-counter/cloudflare && wrangler dev --port 8790   # Calories
cd examples/movie-discovery/cloudflare && wrangler dev --port 8791   # Movies
cd examples/food-ordering/cloudflare   && wrangler dev --port 8792   # Food
cd examples/social/cloudflare          && wrangler dev --port 8793   # Social
cd examples/calculator/cloudflare      && wrangler dev --port 8794   # Calculator
```

Open `http://localhost:8787` and tap an icon. You only need the launcher plus
whichever apps you actually want to open — icons for apps that aren't running
show HypenApp's connection-failed message instead.

## R2 storage setup (Files app)

The Files app's file contents are stored in an R2 bucket bound as
`FILES`. Metadata (names, folders, sizes) stays in each visitor's Durable
Object.

### 1. Create the bucket (once per Cloudflare account)

```bash
bunx wrangler login
bunx wrangler r2 bucket create hypen-home-files
bunx wrangler r2 bucket list          # check that it's there
```

The bucket can stay private: the Worker reads it through its binding and
serves the bytes itself, so you don't need a public bucket, an `r2.dev` URL
or a custom domain.

### 2. Bind it in `wrangler.jsonc`

This is already in the example's `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "no_web_socket_compression"],

  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "hypen-home-files" }
  ]
}
```

- `binding` is the name the code reads (`env.FILES`, see `src/worker.ts` and `src/drive.ts`).
  Keep it as is.
- `bucket_name` must match the bucket you created. To use another name,
  create that bucket and change only `bucket_name`.
- `no_web_socket_compression` is required for uploads. Without it, workerd
  compresses the WebSocket with context takeover, browsers keep the
  connection UI-only (no device plane), and every upload fails as
  unavailable.

To keep dev and production data apart, add
`"preview_bucket_name": "hypen-home-files-dev"` (and create that bucket too).
`wrangler dev --remote` then uses the preview bucket.

### 3. Local development

`wrangler dev` (or `scripts/dev-examples.sh` from the repo root) emulates
the bucket locally, so you don't need to create anything to run the
example. Objects land under `.wrangler/state/v3/r2/hypen-home-files/`; delete
`.wrangler/state` (with the server stopped) to start fresh.

### 4. Deploy and verify

```bash
bun run deploy
bunx wrangler r2 bucket info hypen-home-files    # object count and size grow after an upload
```

Objects are keyed `drive/<Durable Object id>/<file id>` (one prefix per visitor).
You can also browse them under R2 in the Cloudflare dashboard. If the
bucket doesn't exist, the deploy fails. Create it (step 1) and deploy again.

## Deploying

Create the Files bucket first (see
[R2 storage setup](#r2-storage-setup-files-app)):

```bash
bunx wrangler r2 bucket create hypen-home-files
```

Deploy the sibling examples (`bun run deploy` in each), then edit the `APPS`
list in `src/launcher.ts` and swap each `url` for the deployed endpoint, e.g.

```ts
url: "wss://hypen-todo.<your-subdomain>.workers.dev/ws",
```

(`wss://`, not `https://` — `HypenApp` speaks the Hypen remote-UI WebSocket
protocol.) Then deploy the launcher itself.

## What it shows off

- **`HypenApp` composition** — one Hypen app embedding live, independent
  Hypen apps by URL. Each embedded app keeps its own engine, state, and
  session on its own worker; the launcher just streams its patches into the
  frame.
- **Router as an app switcher** — `/` is the home screen, `/app/<slug>` is a
  full-screen app frame. The generic client mirrors the URL into
  `state.location`, so deep links (`/app/todo`) and the browser back
  button behave like a phone's back gesture.
- **Templates are strings** — the icon grid and the per-app routes are
  generated from the `APPS` array with plain TypeScript string interpolation.
  Adding an app to the phone is one entry in a list.
- **Reactive theming** — the ⚙ Settings icon opens the launcher's own
  `/settings` route: wallpaper presets and an accent color, both plain state.
  The wallpaper is an applicator binding and the accent tints the app-frame
  chrome, so picking a swatch restyles the phone through ordinary reactive
  updates — including the *detached* home route in the Router cache (the
  engine emits the `SetProp` against the kept-alive subtree, so navigating
  back shows the new wallpaper instantly). Both choices persist in the
  Durable Object across reloads and deploys.
- **Responsive wallpapers, from Unsplash** — the photo presets come from
  Unsplash's [Wallpapers topic](https://unsplash.com/t/wallpapers), hotlinked
  from `images.unsplash.com` (an imgix endpoint), so one photo id yields as
  many renditions as we want. The binding is a *value map* rather than a
  single value:

  ```
  .background({default: "@{state.wallpaper}", sm: "…", md: "…", lg: "…", xl: "…"})
  ```

  which lowers to one `@media (min-width: …)` rule per breakpoint. The
  browser downloads only the rule that matches, so a desktop window pulls a
  3072×1728 crop and a phone pulls 1080×1920 — and the *aspect* changes too,
  so a wide window gets a landscape crop instead of a portrait one scaled up.
  `auto=format` serves AVIF/WebP where supported. No API key: to change the
  set, swap photo ids into `WALLPAPER_PHOTOS` in `src/unsplash.ts` and the
  settings picker follows.

- **Files: a personal drive with drag and drop.** The Files icon opens
  the launcher's own `/files` screen: folders, image thumbnails, upload,
  download, delete.
  - *Upload* is `file.pick` over the device plane. Drag files from the
    desktop onto the list (`.onFileDragEnter`) and the browser's device host
    shows its dialog under the drag, with a drop zone to release them on. You
    can also tap Upload and use the picker. The list never receives file data.
  - *Download* is `file.save`. The host asks for consent and a destination.
  - *Move* is ordinary Hypen drag and drop: rows are `.draggable`, folders
    and breadcrumbs are `.dropZone`s.
  - *Storage*: each visitor gets their own Durable Object, keyed by an
    HttpOnly `hypen_home` cookie. Metadata lives in its SQLite; bytes live
    in the `FILES` **R2 bucket** under `drive/<DO id>/`. Handlers reach their
    own DO through `AsyncLocalStorage` (`src/drive.ts`), never through a
    module global, so two visitors' long uploads can't cross. Limits: 16 MB per
    upload batch, 200 MB per visitor. `/drive/<id>` serves image thumbnails
    only (sniffed, sandboxed); other files download through `file.save`.
  - Before the first deploy, create the bucket. See
    [R2 storage setup](#r2-storage-setup-files-app).

## Notes

- Leaving an app's route *detaches* its subtree into the Router cache — the
  frame's WebSocket stays connected, so re-entering the app is instant and
  live. Only a real removal (Router LRU eviction) closes the connection.
- `HypenApp` connects with the default (session-less) client options: every
  visitor embedding the same URL shares that app's Durable Object session at
  that path. For the shared-by-design examples (Todo) that's the point;
  for per-user apps, point the URL at a path per user (the default worker
  routing keys the DO by URL path).
