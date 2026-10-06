# Hypen Social — Cloudflare Worker + Durable Object

CF port of `../typescript/`. Same `queries.ts` and `module.ts` source,
running inside a Durable Object with DO SQLite replacing `bun:sqlite`.

## Architecture

Same as `../../calorie-counter/cloudflare`, with the addition that the
component templates live in standalone `src/components/*.hypen` files
(bundled via wrangler's `Text` rule and mapped to module names in
`src/templates.ts`).

## Uploads (device plane)

Hypengram is a real shared app: every connection (the standalone page, the
canvas page and the Home launcher's embed) goes to **one** Durable Object, so
posts, likes, comments and photos are the same for everyone and survive
reloads.

- **New post** (`/create`, the ＋ in the header and tab bar): "Choose from
  library" (`gallery.pick`) or "Take photo" (`camera.capture`, shown when the
  device has a camera), then a caption and location. Dragging a photo from
  the desktop over the preview asks for it too: the browser's device host
  pops its dialog up under the drag with a drop zone.
- **Change photo** on the profile replaces the avatar the same way.

The photo never passes through the UI: the handler awaits
`context.device.request(...)`, and the served client's `WebDeviceHost` shows
its own consent dialog and picker. The bytes are checked again on the server
(magic-byte sniffing, 10 MB cap). They go to the `MEDIA` **R2 bucket**, with
metadata in the DO's SQLite, and `GET /media/<id>` streams them straight
from R2 (see `src/media.ts`). Setup is described in
[R2 storage setup](#r2-storage-setup).

`wrangler.jsonc` sets `no_web_socket_compression`. With workerd's default
compression (context takeover) browsers keep the socket UI-only and uploads
are unavailable.

## Run locally

```bash
bun install
bun run dev           # wrangler dev on http://localhost:8787
```

Connect a DOM or Canvas client to `ws://localhost:8787/ws`.

## R2 storage setup

Uploaded photos (new posts and avatars) are stored in an R2 bucket bound
as `MEDIA`. Metadata stays in the Durable Object's SQLite.

### 1. Create the bucket (once per Cloudflare account)

```bash
bunx wrangler login
bunx wrangler r2 bucket create hypen-social-media
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
    { "binding": "MEDIA", "bucket_name": "hypen-social-media" }
  ]
}
```

- `binding` is the name the code reads (`env.MEDIA`, see `src/worker.ts` and `src/media.ts`).
  Keep it as is.
- `bucket_name` must match the bucket you created. To use another name,
  create that bucket and change only `bucket_name`.
- `no_web_socket_compression` is required for uploads. Without it, workerd
  compresses the WebSocket with context takeover, browsers keep the
  connection UI-only (no device plane), and every upload fails as
  unavailable.

To keep dev and production data apart, add
`"preview_bucket_name": "hypen-social-media-dev"` (and create that bucket too).
`wrangler dev --remote` then uses the preview bucket.

### 3. Local development

`wrangler dev` (or `scripts/dev-examples.sh` from the repo root) emulates
the bucket locally, so you don't need to create anything to run the
example. Objects land under `.wrangler/state/v3/r2/hypen-social-media/`; delete
`.wrangler/state` (with the server stopped) to start fresh.

### 4. Deploy and verify

```bash
bun run deploy
bunx wrangler r2 bucket info hypen-social-media    # object count and size grow after an upload
```

Objects are keyed `media/<id>`.
You can also browse them under R2 in the Cloudflare dashboard. If the
bucket doesn't exist, the deploy fails. Create it (step 1) and deploy again.

## Deploy

```bash
bunx wrangler login
bunx wrangler r2 bucket create hypen-social-media   # once, see "R2 storage setup"
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
