# Radio

Live internet radio built with Hypen, on the community-run
[Radio Browser](https://www.radio-browser.info/) directory (no API key). You
can browse what's popular in your country, what's trending, or go by genre,
country or language. You can also search by name, open a station page, and
keep listening in a mini-player while you browse. Favourites and recently
played are saved per visitor in a Durable Object.

Audio goes straight from each broadcaster to the client's media stack. The
worker only handles JSON metadata, station artwork, and a short server-side
read of ICY "now playing" titles. It never relays audio to clients.

```
examples/radio/
├── README.md
└── cloudflare/
    ├── wrangler.jsonc            # Worker config (DO: RadioDO), dev port 8799 / inspector 9241
    ├── package.json
    ├── tsconfig.json
    ├── test/
    │   ├── radio.test.ts         # bun test: filtering, query params, ICY parsing, artwork fallback
    │   └── fixtures/stations-search.json   # recorded /json/stations/search response
    └── src/
        ├── worker.ts             # defineHypenWorker + visitor cookie + country scope + /art route
        ├── radio-browser.ts      # API client: server list, User-Agent, search, categories, click counting
        ├── player.ts             # shared player state + start/stop/favourite + ICY polling
        ├── icy.ts                # ICY metadata reader (first StreamTitle block, then hang up)
        ├── art.ts                # /art/<uuid>: validated favicon, or a generated monogram tile
        ├── visitor.ts            # hypen_radio cookie, request.cf.country → AsyncLocalStorage scope
        ├── library-store.ts      # persists only favourites / recents / last station
        ├── screen-actions.ts     # play / openStation / back shared by screen modules
        ├── ui.ts                 # shared DSL fragments (station rows, headers, skeletons)
        ├── icons.ts              # inline SVG icon resources
        └── components/
            ├── App.ts            # shell: Router, mini-player, tab bar, /library, /player, the Video
            ├── Discover.ts       # popular near you, top clicked, trending, genre shortcuts
            ├── Categories.ts     # /browse/genres|countries|languages with filter
            ├── StationList.ts    # /list/:kind/:value
            ├── Search.ts         # /search (debounced name search)
            └── StationDetail.ts  # /station/:id
```

## Run it

```bash
cd examples/radio/cloudflare
bun install
bun run dev          # wrangler dev → http://localhost:8799 (or /canvas for the canvas renderer)
bun test             # unit tests (no network)
bun run typecheck
```

In the phone launcher, embed it with `HypenApp("ws://localhost:8799/ws")`.
Deploy with `bunx wrangler login && bun run deploy`.

## How audio playback works

Hypen has two media primitives:

| | `Audio` | `Video` |
|---|---|---|
| Web DOM | native `<audio controls>` | full contract: events, `muted`, slots, `.bind` |
| Canvas | painted controls + offscreen audio | offscreen media element, events |
| iOS | `AVPlayer` with its own UI | `AVPlayer` |
| Android | ExoPlayer with a fixed light UI | ExoPlayer |
| Desktop | painted control surface | GStreamer pipeline (`video` feature) |
| Events (`onPlay`/`onPause`/`onError`) | none | yes (the documented cross-platform contract) |
| `muted` | DOM only | yes |

`Audio` has no events and draws its own chrome. On Android that chrome is a
fixed light-grey bar, so the app couldn't tell whether a stream had started
or failed. This app uses **`Video` as an audio-only player**: a
zero-size, chrome-less `Video` lives in the App shell, outside the Router, so
it keeps playing while you browse. Every platform's video stack (`<video>`,
AVPlayer, ExoPlayer) plays audio-only MP3/AAC streams. The mini-player and
`/player` screen are its controls. `onPlay`, `onPause` and `onError` drive
the status line ("Connecting…" → "Live", or "Stream unavailable").

- **Stop, not pause.** Stopping unmounts the `Video` (`If(state.live)`), which
  closes the connection. Pressing play remounts it and reconnects at the live
  edge, so you never resume minutes-old buffered audio.
- **Volume:** no renderer's `Video` contract has a volume control (device
  volume applies), so the app offers a **mute** toggle through the `muted`
  prop.
- **Formats:** stations are filtered to **https, non-HLS, MP3/AAC/AAC+**:
  - `is_https=true` at the API, and `hls`/codec filtered locally.
  - Plain-http streams are blocked as mixed content on an https page.
  - HLS only plays natively in Safari/AVPlayer.
  - OGG/Opus doesn't play on Apple platforms.

  A station page explains why a filtered station can't be played.
- **CORS:** a media element doesn't need CORS to play a cross-origin stream.
  It's only needed by the renderer's optional 1-byte probe that recovers an
  HTTP status for `onError`. Without CORS, errors read "This stream couldn't
  be played" with no status code.
- **Autoplay policy:** playback starts after a server round trip from your
  tap. Chrome, Firefox and the native apps allow it because the page has
  already had a user interaction. **iOS Safari (web)** requires `play()`
  inside the tap handler itself. There the renderer's muted-autoplay fallback
  may start the stream muted, so un-mute it in the full player. Native
  iOS/Android are not affected.

## Radio Browser etiquette

- API host chosen at random from `all.api.radio-browser.info/json/servers`,
  falling back to the `de1`/`de2`/`fi1` mirrors.
- Generic descriptive User-Agent: `HypenRadioExample/1.0 (open-source Hypen UI example app)`.
- When a listener starts a station, the worker calls `GET /json/url/<uuid>`
  so Radio Browser counts a click.

## Now playing (ICY) — honest by construction

Browsers can't read the in-band ICY metadata of a stream. So while a station
is live, the worker requests the stream itself every 30 s:

1. It sends `Icy-MetaData: 1` and follows redirects by hand.
2. It reads up to the first metadata block, at the `icy-metaint` offset
   (64 KB at most). The audio bytes before that block are discarded.
3. It parses `StreamTitle='…'` and hangs up.

The player shows the title under "ON AIR · from the stream" only when the
station actually sent one. Stations without ICY, empty titles, and
letterless IDs such as `4727 - 4727` show only "Live". Polling stops for
streams that don't advertise ICY. Note that the title is whatever the station
sends: some stations put their slogan there.

## Per-visitor persistence

- **Visitor cookie.** The worker mints a random `hypen_radio` cookie
  (HttpOnly, SameSite=Lax). It sets the cookie on the page response *and* on
  the WebSocket 101 response, because inside the launcher the browser never
  loads this worker's page.
- **One Durable Object per visitor.** Every socket from that browser is
  routed to the same Durable Object.
- **What persists.** `library-store.ts` saves only favourites, recently played
  and the last station. Playback state is never saved, so a reload never
  starts audio on its own; the mini-player shows the last station as "Tap
  play to listen".
- **Limitation.** A deployed embed at `*.workers.dev` from a launcher on
  another `*.workers.dev` host is cross-site. There the cookie is a
  third-party cookie, and browsers that block those get a fresh library per
  connection.

## Country

"Popular in …" uses `request.cf.country`. The worker stamps it into a header
for the Durable Object hop. The Durable Object stores it, so it survives
hibernation, and runs every entry point inside an `AsyncLocalStorage` scope.
Two visitors whose Durable Objects share an isolate therefore never see each
other's country. When there is no country (offline `wrangler dev`), it falls
back to US. Countries, genres and languages can always be browsed by hand.

## Known limitations / SDK notes

- **`.label("@{…}")` with a binding isn't exposed on Buttons.** The engine's
  `Semantics::with_resolved_name` never looks at `label.0`, so templated
  labels produce no `aria-label`. All labels in this app are static strings.
- **`.bind(@state.playback)` on the `Video` is not used.** With the published
  client, the bind reports `playing: false` while autoplay is pending. The
  engine echoes that write back, and the echo pauses the element: it ends
  paused after a play/pause ping-pong. The app uses events instead.
- **The primary (App) module's handlers get no `context.router`.** A screen
  module's `router.push("/player")`, to an inline route with no module behind
  it, does nothing. The shell navigates by writing `state.location`, which
  works and keeps the URL in sync.
- **`Link` isn't a registered primitive** in the published engine, so the
  station website is shown as text.
- **Canvas renderer:**
  - `Heading` isn't painted, so section titles are missing on `/canvas`.
  - SVG `<text>` in the monogram artwork tiles isn't drawn.
  - Image corner radii aren't clipped.
  - Playback works.
