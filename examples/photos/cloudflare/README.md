# Photos — Hypen Example

A camera roll and photo library for the Hypen home screen. Take photos with
the device camera, import from the photo library or drop image files from the
desktop, then browse them by day, open them full screen, swipe between them,
mark favourites, file them into albums by drag and drop, download or delete
them. Each photo's EXIF data (capture date, camera, exposure, GPS) is read on
the server and the GPS position is turned into a place name.

```
photos/
└── cloudflare/
    ├── src/
    │   ├── photos.ts          # module: state, actions, generated DSL template
    │   ├── library.ts         # per-visitor storage: DO SQLite rows + R2 bytes, /p/<id> serving
    │   ├── exif.ts            # dependency-free EXIF/size reader (JPEG, PNG, WebP, GIF)
    │   ├── geocode.ts         # Nominatim reverse geocoding (throttled, cached)
    │   ├── icons.ts           # SVG resources
    │   ├── worker.ts          # defineHypenWorker wiring, visitor cookie, DO scope
    │   └── photos.test.ts     # bun test: EXIF, sniffing, formatting
    ├── scripts/local-overlay.sh   # overlay this checkout's engine + SDK (device plane)
    ├── wrangler.jsonc
    ├── package.json
    └── tsconfig.json
```

## Run it

Port **8797** (inspector **9239**), set in `wrangler.jsonc`:

```bash
cd examples/photos/cloudflare
bun install
scripts/local-overlay.sh      # see "Device plane" below
bun run dev                   # wrangler dev → http://localhost:8797
```

In the home-screen launcher it is embedded as
`HypenApp("ws://localhost:8797/ws")`.

### Device plane (camera, imports, downloads)

Every byte moves through the Device Capability Protocol (RFC 001):

| Feature | Capability | UI |
|---|---|---|
| Shutter button, "Take photo" | `camera.capture` | host camera dialog (live preview + Capture) |
| Import tab | `gallery.pick` | host photo picker |
| Upload button, files dropped from the desktop | `file.pick` | host dialog with a drop zone |
| Download in the viewer | `file.save` | host save dialog |

Dragging image files from the desktop over the library lights it up
(`.dropZone(files: true, accept: "image/*")`) and `.onFileDragEnter` asks for
a `file.pick` right away; the host dialog opens under the held drag and the
files are dropped onto it. The page never hands file data to the app itself.

The published `hypen-engine` has no device broker, so with the published
packages the worker logs `Device plane off` and these buttons answer "This
device can't …". `scripts/local-overlay.sh` copies this checkout's engine web
build (`hypen-engine-rs/pkg/web`, built with `./build-wasm.sh`) and the built
`@hypen-space/{core,web,cf}` dists into `node_modules`, and applies the same
wrangler ProxyWorker patch as `scripts/dev-examples.sh` (without it browsers
refuse the device plane under `wrangler dev`). `ENGINE_WEB=…` and `WEB_DIR=…`
point it at other builds. A later `bun install` restores the published
packages.

### R2 bucket

Photo bytes live in the `PHOTOS` R2 bucket (`hypen-photos`); metadata lives
in each visitor's Durable Object SQLite. `wrangler dev` emulates the bucket
under `.wrangler/state`. Before the first deploy, create it once:

```bash
bunx wrangler r2 bucket create hypen-photos
bunx wrangler deploy
```

To start over locally, stop the server and delete `.wrangler/`.

## How it works

**One library per visitor.** The worker routes each socket to a Durable
Object keyed by a random `hypen_photos` cookie (HttpOnly, SameSite=Lax). The
cookie is set on the first page load and also on the WebSocket handshake,
because inside the launcher the handshake is the only response the browser
ever gets from this origin. Handlers reach the visitor's SQLite and R2 prefix
through `AsyncLocalStorage` (`libraryScope.run(…)` around every DO entry
point), never through a module global: several DOs can share an isolate, and a
camera capture can wait on the user for a long time. Same pattern as the Files
app in `examples/home-screen` (`src/drive.ts`).

Deployed on `*.workers.dev`, the launcher and this worker are different sites,
so the Lax cookie is not sent from inside the launcher. Each launch there gets
a fresh library unless the visitor has opened the app on its own origin. Use
one custom domain for both, or replace the cookie with real accounts.

**Serving images.** `GET /p/<DO id>/<photo id>` is routed by the DO id (no
cookie needed) and serves the bytes only when they sniff as JPEG, PNG, GIF,
WebP or AVIF, with `nosniff` and a sandboxing CSP. An upload that is really
HTML or SVG never renders on this origin. HEIC photos are stored and
downloadable but shown as a placeholder, because browsers cannot display
them. The URLs are relative; `HypenApp` resolves them against this worker
when embedded. Photos are served at full size: Workers have no built-in
resizer. Add Cloudflare Images for real thumbnails.

**Metadata.** `exif.ts` reads `DateTimeOriginal` (falling back to
`DateTimeDigitized`/`DateTime`), make, model, lens, f-number, exposure, ISO,
focal length, GPS position and altitude, orientation, and the pixel size from
the SOF/IHDR/VP8 headers. Every offset is bounds-checked and the reader never
throws. A photo without an EXIF date is dated by when it was added, in the
visitor's time zone (`request.cf.timezone`). The library groups photos by
that local day ("Today", "Yesterday", "Monday, Nov 9", "Mar 2, 2025").

**Places.** GPS positions are reverse-geocoded with
[Nominatim](https://nominatim.org/), following its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/):

- a descriptive, generic `User-Agent` that names this example and nothing
  about the user;
- at most one request per second, from a single queue per isolate;
- positions rounded to about 100 m and cached in memory and in the visitor's
  SQLite, so a lookup is never repeated;
- "© OpenStreetMap contributors" shown next to the place.

Only the rounded coordinates leave the worker. For real traffic, run your own
Nominatim or use a commercial geocoder.

**UI.** One module with a `Router` on its `location` state: `/` (library),
`/favorites`, `/albums`, `/album` and `/photo` (viewer). Handlers navigate by
writing `state.location`.

- The tapped tile flies into the viewer and back with
  `.sharedElement("photo-hero")`. As in movie-discovery, the tile's key is set
  one render before the navigation.
- In the viewer, swiping left goes to the next photo and swiping right to the
  previous one. Each direction is a `.scrub/.settle` pair on nested nodes.
  The arrow buttons do the same.
- Tiles are `.draggable()` inside a `.sortable(group: "photos", axis: y)`
  grid. The sortable gives the tiles `touch-action: pan-y`, so the grid still
  scrolls on phones; a loose draggable would get `touch-action: none`. The
  grid has no `.bind`/`.onSort`, so a drop back into the grid does nothing,
  because the order is by date. Favorites and every album chip are
  `.dropZone(group: "photos")` targets.

## Tests

```bash
bun test            # EXIF parsing (incl. truncated/hostile input), sniffing, formatting
bun run typecheck
```

## Known issues (engine/SDK) and their workarounds

1. **`.settle(bind:)` writes are rejected by the engine.** The renderer sends
   the settle write as `__hypen_bind`, and `validate_ui_write`
   (`hypen-engine-rs/src/action_routing.rs`) accepts it only for a node whose
   `bind` prop declares the path. The scrub's `__anim.scrubBind` does not
   count, so the write fails with `invalid UI write target`. Workaround: the
   scrubbed nodes also carry `.bind(@state.swipeNext)` / `.bind(@state.swipePrev)`.
   The DOM renderer logs a harmless `.bind() is not supported on element type
   "column"/"row"` warning for these.
2. **A settle write runs no handler.** The pose's `.onAnimationComplete` did
   not fire for the label the scrub settled on. While the viewer is open, the
   module checks `swipeNext`/`swipePrev` every 100 ms and pages when one of
   them reads "next"/"prev".
3. **Native image drag swallows Hypen DnD.** An `<img>` inside a
   `.draggable` starts the browser's own image drag (`dragstart`), so the
   pointer drag never lifts. Workaround: `.pointerEvents("none")` on the tile
   and viewer images.
4. **`context.router` was not wired** for this single-module DO app.
   `context.router?.push()` left `location` unchanged, so handlers write
   `state.location` directly.
