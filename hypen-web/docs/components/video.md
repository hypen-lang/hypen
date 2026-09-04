# Video Component Contract

`Video` is a built-in primitive (engine `DEFAULT_PRIMITIVES`, renderer `typeName: "video"`).
This document is the cross-platform contract every renderer (web DOM, canvas, Android,
iOS, desktop) implements. Platform notes call out where a capability degrades.

The guiding rule: **only resolved, streamable URLs cross the wire — never media
payloads.** The server resolves a stream endpoint (e.g. a progressive MP4 URL) and
sends the string; the client platform's media stack does the streaming.

## Usage

```hypen
// Single source
Video(src: "https://example.com/movie.mp4", controls: true)
    .fillMaxWidth(true)
    .height(220)

// Playlist (array of resolved URLs, played in order)
Video(
    playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
    controls: true,
    onTrackChange: @actions.trackChanged,
    onEnded: @actions.playbackDone,
    onError: @actions.playbackFailed,
)

// Auth-protected stream
Video(src: "@{state.streamUrl}", headers: {"Authorization": "Bearer @{state.token}"})
```

## Props (common denominator)

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `0` / `src` / `source` | string | — | Resolved streamable URL (progressive MP4/WebM; HLS where the platform supports it). |
| `playlist` | array&lt;string&gt; | `[]` | Ordered play queue. When non-empty it supersedes `src`. Advances automatically when a track ends. |
| `startIndex` | number | `0` | Index into `playlist` to start from. Clamped to valid range. |
| `poster` | string | — | Image URL shown before playback starts. |
| `controls` | bool | `false` | Native transport controls where the platform has them. |
| `autoplay` | bool | `false` | Start playback when ready. Renderers should fall back to muted autoplay where platforms require it (browsers). |
| `loop` | bool | `false` | Single source: loop the video. Playlist: wrap to track 0 after the last track. |
| `muted` | bool | `false` | Start muted. |
| `preload` | string | `"metadata"` | Web hint: `none` \| `metadata` \| `auto`. Other platforms may ignore. |
| `headers` | map&lt;string,string&gt; | — | Extra HTTP request headers for media fetches (streams behind auth). See platform notes. |

Sizing behaves like `Image`: the element participates in layout normally; use the
usual size applicators (`.width/.height/.fillMaxWidth/.aspectRatio`). `objectFit`
(`contain`/`cover`/`fill`, default `contain`) applies where the platform supports it.

## Accessibility

The engine derives a `video` role with an accessible name from a `title`
(preferred), `label`, or `alt` prop — or an explicit `.label(...)` applicator,
which always overrides. A `Video` with none of these is flagged by the
dev-mode conformance check (`video-missing-label`), the same treatment as an
`Image` without `alt`; mark purely decorative background video `.hidden()`.
Native transport controls are the platform's own accessible controls — the
label names the player, it does not replace `controls`.

## Events (action props)

All events are optional action references (`@actions.name`). Payloads are plain JSON.
`index` is the playlist index (`0` for single-src playback); `src` is the URL of the
track the event refers to.

| Prop | Fires | Payload |
|---|---|---|
| `onPlay` | playback starts/resumes | `{ type: "play", src, index }` |
| `onPause` | playback pauses | `{ type: "pause", src, index }` |
| `onEnded` | a track finishes | `{ type: "ended", src, index, completed }` — `completed: true` when the whole queue is done (always true for single src without `loop`) |
| `onTrackChange` | the queue advances to a new track | `{ type: "trackchange", src, index }` |
| `onError` | the stream cannot be fetched or decoded | `{ type: "error", src, index, status?, code?, message }` |

### `onError` / failure modes (normative)

1. **No `src` and no `playlist`** → render an empty placeholder box. No crash, no dispatch.
2. **HTTP error (401/403/404/5xx)** → dispatch `onError` with `status` set to the HTTP
   status code whenever the platform can determine it (see below). The renderer shows a
   quiet error state (poster or dark box) — never an infinite spinner.
3. **Network/decode error mid-stream** → `onError` with platform `code` + `message`;
   `status` omitted when unknown. On a playlist the renderer does **not** auto-skip the
   failed track — the module decides what to do in its `onError` handler.
4. **Payloads never cross the wire.** A renderer receiving anything but URLs is a bug.

How `status` is determined per platform:

- **Android** — Media3 `HttpDataSource.InvalidResponseCodeException.responseCode`.
- **iOS** — `AVPlayerItem.errorLog()` / underlying `NSError` where derivable.
- **Web DOM / canvas** — media elements don't expose HTTP status, so after a
  `MediaError` the renderer issues a 1-byte ranged probe
  (`fetch(src, { headers: { Range: "bytes=0-0", ...headers } })`) and reports the
  probe's status. If CORS blocks the probe, `status` is omitted.
- **Desktop** — status from the poster/probe fetch.

## `headers` platform notes

- **Android**: applied via `DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers)`.
- **iOS**: applied via `AVURLAsset(url:, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])`.
- **Web DOM / canvas**: HTML media elements cannot attach request headers, so a
  `headers` fetch goes through a tiered fallback. The response is sniffed
  (`sniffContainer`): fragmented MP4 and WebM stream through **MediaSource while
  downloading** (object URL assigned immediately, chunks appended with
  backpressure, played ranges evicted on quota pressure); non-streamable
  containers (progressive MP4) fall back to accumulate-to-`Blob`, reusing the
  already-read bytes. Prefer cookie/query-token auth (or fMP4/WebM encodes) for
  feature-length auth'd streams on the web. Without `headers` the URL is
  assigned directly and streams natively. Fetch failures (401/403/404/network)
  dispatch `onError` with `status`.
- **Desktop**: applied to media fetches (souphttpsrc `extra-headers`, with the
  `video` feature) and to poster/probe fetches.

**Redirect scope (security)**: the platform media stacks re-send `headers` on
same-protocol redirects, including cross-host ones (Media3's default data
source, `AVURLAssetHTTPHeaderFieldsKey`, and the web tier's probe all behave
this way). A bearer token in `headers` therefore reaches whatever host the
CDN redirects to — archive.org, for example, 302s to per-item edge hosts. Do
not put credentials in `headers` for streams that redirect across origins you
don't control; prefer short-lived signed URLs minted server-side for that
topology. Renderer-side same-host scoping is tracked as future work.

## Platform capability matrix

| Capability | DOM | Canvas | Android | iOS | Desktop |
|---|---|---|---|---|---|
| Progressive MP4/WebM streaming | ✅ | ✅ (offscreen `<video>` → canvas) | ✅ ExoPlayer | ✅ AVPlayer | ✅ with `video` feature (GStreamer); poster + glyph otherwise |
| HLS | Safari native only | Safari native only | ✅ | ✅ | ❌ |
| Native controls | ✅ | tap play/pause | ✅ PlayerView | ✅ VideoPlayer | tap play/pause (`video` feature) |
| Playlist auto-advance | ✅ | ✅ | ✅ (queue of MediaItems) | ✅ (queue via item replacement) | ✅ with `video` feature |
| Pre-playback `poster` | ✅ | ✅ | ✅ (overlay until first frame) | best effort | ✅ |
| `headers` | MSE stream / blob tiers | MSE stream / blob tiers | ✅ | ✅ | ✅ with `video` feature; probe/poster otherwise |
| `onError` with HTTP `status` | probe | probe | ✅ | best effort | best effort (bus-message extraction) / probe |
| v2 `playback` bind + slots + `Scrubber` | ✅ | ✅ | ✅ | ✅ | ✅ (slots also without the feature, for `idle`/`error`) |
| Fullscreen (`videoIntent`) | ✅ container | ✅ canvas host | ✅ immersive dialog (same player) | ✅ fullScreenCover (same player) | ✅ window (no `video` feature needed) |

Desktop playback is opt-in: build `hypen-renderer-desktop` with the `video` cargo
feature (GStreamer system libraries required — playbin → RGBA appsink composited
by both painters; frame-driven repaints, playlist advance, loop, `headers` via
souphttpsrc). Without the feature the renderer keeps the dependency-free
poster/play-glyph behavior. Tap toggles play/pause (unless a `controls`
composition slot is present — see the v2 section, which desktop implements);
volume UI and HLS remain future work. Router-cached routes suspend cleanly: a `Detach`ed subtree's
pipeline pauses (dispatching `onPause`) but keeps its position and last frame,
and re-`Attach` resumes playback (dispatching `onPlay`) unless the user had
paused it — so navigating away never leaves audio playing off-screen, and
navigating back resumes where the viewer left off.

## Playback control & composition slots (v2)

> **Status: SHIPPED** on all five renderers (web DOM, canvas, Android, iOS,
> desktop — desktop playback behind the `video` cargo feature; slots work
> without it for the `idle`/`error` states). The normative visibility table
> and constants live in `@hypen-space/core`'s `types.ts`
> (`VIDEO_SLOT_VISIBILITY`, `PLAYBACK_REPORT_INTERVAL_MS`,
> `PLAYBACK_SEEK_EPSILON_S`) — the web renderers key off that data directly
> and the Kotlin/Swift/Rust mirrors cite it. Cross-checked by a five-platform
> reconciliation pass; per-platform narrowings are listed at the end of this
> section.

### Player states (normative)

Every renderer maintains one player state per Video node:

```
idle → loading → playing ⇄ paused → ended
                  ↘        ↙
                    error
```

- `idle` — no src/playlist resolved, or preload hasn't begun. Poster shows.
- `loading` — a source is resolving/buffering and playback has not yet begun,
  OR playback is stalled rebuffering. (Rebuffer re-enters `loading` without
  emitting `onPause`.)
- `playing` / `paused` — self-evident. `ended` — final track finished, no wrap.
- `error` — the sticky failure state described in the `onError` section.

State names are contract vocabulary: slots key off them, and the `playback`
bind struct reports them verbatim.

### Controlling playback from code: `.bind(@state.playback)`

```hypen
Video(src: "@{state.streamUrl}").bind(@state.playback)
```

Binds a **playback struct** — the media analogue of `Input.bind`:

```ts
{
  playing:  boolean,   // read-write
  position: number,    // seconds, read-write (write = seek)
  duration: number,    // seconds, read-only (0 until known)
  state:    string,    // player state above, read-only
}
```

Write semantics (state → renderer):
- `playing: true|false` — play/pause. Writing `true` in `ended` restarts from 0.
- `position: n` — seek. Applied only when it differs from the renderer's actual
  position by more than **1 second** (epsilon guard: prevents the echo of the
  renderer's own progress updates from being re-applied as seeks). Clamped to
  `[0, duration]`.
- Writes to `duration`/`state` are ignored.

Report semantics (renderer → state), throttled:
- `playing` reports play **intent**: it stays `true` through a rebuffer
  (`state` reports `loading`), so a play/pause toggle bound to it doesn't
  flicker mid-stall.
- `position` updates at most every **250 ms** while playing.
- `playing`/`state`/`duration` update immediately on transition (play, pause,
  seek completion, track change, ended, error).
- Reports are plain state mutations — they trigger normal reactivity but MUST
  NOT be echoed back to the renderer as writes (the epsilon guard plus a
  renderer-side "last reported" comparison make the loop converge).

One-way forms also work: `playing: @{state.isPlaying}` as a plain prop is the
controlled subset (module drives, renderer follows; renderer-initiated changes
surface only via events). It shares the bind's write semantics, including
restart-from-`ended`.

A lone `startPosition: number` prop (create-time seek, applied once when the
source becomes seekable) covers "resume where you left off" without a full
bind. It re-arms when the source configuration (`src`/`playlist`/`headers`)
changes, not on unrelated prop updates.

The bind requires the module to initialize the struct in `defineState`
(e.g. `playback: { playing: true, position: 0, duration: 0, state: "idle" }`)
— `__hypen_bind` writes drop silently when the parent path is missing. The
first application of a freshly-bound struct carries **positive intent only**
(`playing: true` plays, a `position` seeks) so an initialized `playing: false`
cannot cancel `autoplay`; every later write is authoritative in both
directions.

### Composition slots

Children tagged with `.slot(name)` compose INTO the player chrome. Untagged
children remain invalid (Video is a leaf for ordinary children). Renderers
overlay slot content on the video surface, full-bleed, in slot order:

```hypen
Video(src: "@{state.url}", autoplay: true) {
    Row {
        Button("@actions.togglePlay") { Icon(name: "pause") }
        Scrubber().bind(@state.playback)
        Text("@{state.timeLabel}")
    }.slot("controls")

    Column { Spinner() }.slot("loading")

    Column {
        Text("Playback failed")
        Button("@actions.retry") { Text("Retry") }
    }.slot("error")

    Image(src: "@{state.richPoster}").slot("poster")
}
```

Slot visibility by player state (normative — renderers MUST match this table):

| Slot | `idle` | `loading` | `playing` | `paused` | `ended` | `error` |
|---|---|---|---|---|---|---|
| `poster` | ✅ | ✅ | — | — | ✅ | — |
| `loading` | — | ✅ | — | — | — | — |
| `controls` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `error` | — | — | — | — | — | ✅ |

Slots paint bottom-to-top as `poster → loading → controls → error` (co-visible
pairs: poster+loading in `loading`, poster+controls in `idle`/`ended`).
`controls` is visible in `idle` so a custom controls slot can start first
play, and in `loading` so a buffering stream still offers its transport; a ready-but-never-played source is `idle` (poster, not spinner) —
`loading` covers load-in-flight and rebuffering only, and `paused` requires
playback to have begun.

- A present slot **replaces** the built-in for that concern: `controls` slot
  suppresses native chrome regardless of the `controls` prop; `error` slot
  replaces the renderer-drawn error surface; `poster` slot replaces the
  `poster` prop's image; `loading` replaces any built-in spinner.
- Absent slots keep today's shipped behavior — this section is purely additive.
- Slot content is ordinary Hypen UI: full applicator support, normal `@actions`
  dispatch, reactive `@{state.*}` bindings. Slot children live in the regular
  node tree (patches, reconciliation, a11y) — only their *painting* is overlaid.
- Visibility is renderer-managed show/hide (the `HypenApp` loading/error slot
  mechanism), NOT mount/unmount: slot subtrees keep their state across
  transitions.

### `Scrubber` (built-in, slot-aware)

A timeline widget designed for the `controls` slot. Inside a Video it wires
itself to the **enclosing player renderer-side**: thumb position tracks
playback at frame rate without touching module state, dragging previews
locally, and only the release commits. Commit resolution: the Scrubber's own
`.bind(...)` wins, else the enclosing Video's bind, else the Scrubber's
`onSeek` action (`{type:"seek", position}`); the local seek applies in every
case, so the playhead moves even with no wire commit. Outside a Video, `Scrubber` renders inert.
This keeps scrubbing responsive on remote apps where a state round trip has
network latency.

### Fullscreen: `videoIntent("fullscreen")` (renderer-local)

Fullscreen cannot ride the normal action→module→state round trip: platforms
gate it behind a user gesture (the web's transient activation), which a
network hop can lose. It is therefore the first shipped **renderer-local
intent**: tag any element inside a Video's subtree (typically a controls-slot
button) with `.videoIntent("fullscreen")` and the renderer toggles fullscreen
in the gesture handler itself — no round trip, no module involvement.

```hypen
Button { Icon(@resources.fullscreen) }
    .videoIntent("fullscreen")
    .label("Toggle fullscreen")
```

Normative semantics: the target of fullscreen is the **video container**
(the wrapper that hosts the surface AND the composition slots) — never the
raw platform video element, whose native fullscreen chrome would replace the
custom controls. Slot overlays, their visibility rules, and the playback
bind keep working in fullscreen unchanged. Per-platform mapping: web DOM
fullscreens the container via the Fullscreen API; canvas fullscreens its HOST
element (the canvas paints the whole app, so surface and painted slot chrome
scale together — the same guarantee); desktop toggles the winit window
fullscreen with the player filling it; Android enters immersive mode (system
bars hidden, player expanded); iOS presents a full-screen cover. Player state
and events are unaffected — fullscreen is presentation only, and it never
dispatches an action. Status: **shipped on web DOM, canvas, desktop,
Android and iOS** (the intent prop is inert where unimplemented, so authors
can ship it everywhere today).

Activation rules where shipped: the intent fires on a completed
press-and-release on the tagged node (a press that drifts off it does
nothing); the node is interactive on the intent alone, so no `.onClick` is
required — and an `.onClick` wired alongside still dispatches normally. A
tagged node OUTSIDE a Video subtree is inert, and an intent name this
renderer doesn't know is inert too (forward compatibility). On desktop the
intent is also reachable by keyboard (Enter / Space on the focused control)
and by assistive-tech activation, and it does NOT require the `video` cargo
feature — a poster-only build still fullscreens.

### Local transport intents (phase 2, sketch)

For latency-critical buttons, a reserved `@video.*` action namespace handled
by the enclosing Video without a module round trip:
`@video.toggle`, `@video.play`, `@video.pause`, `@video.seek(±n)`,
`@video.restart`. Outcomes surface through the normal events/bind flow, so
modules stay authoritative observers. Needs engine support for
renderer-local action routing — deliberately out of scope for v2.

### Non-goals (v2)

Volume/rate control beyond `.playbackRate(n)` applicator parity,
picture-in-picture, frame-accurate seeking, and thumbnail scrub previews.
(Fullscreen graduated out of the non-goals via `videoIntent("fullscreen")`
above.)

### Per-platform narrowings (v2)

Recorded deviations from a five-platform reconciliation pass — none
observable beyond sub-second state labels or documented capability gaps:

- **Intent-less preload naming**: during a non-autoplay load-in-flight with
  no play intent, DOM and Android report `loading` (spinner slot) while
  canvas, iOS, and desktop report `idle` (poster). All settle to `idle` once
  ready; the split covers only the initial fetch window.
- **Desktop**: mid-playback rebuffering is not detected (needs
  `GST_MESSAGE_BUFFERING` plumbing) — a stall stays `playing`; preroll and
  initial buffering do read `loading`. `position` writes seek with
  `KEY_UNIT`, landing at or before the requested time. A pipeline paused
  during preroll reads `paused`. `videoIntent("fullscreen")` promotes the
  whole WINDOW (borderless, current monitor) because desktop has no
  per-player container to promote: anything else on screen in the same
  window goes fullscreen with the player.
- **Canvas**: the Scrubber is exposed with the slider role and live values
  but is not keyboard-focusable (the canvas focus layer covers
  input/textarea/button only — the existing Slider shares this); a drag
  released outside the canvas is dropped, not committed; slot overlays are
  not clipped to a rounded player's corners; under the `headers` blob tier
  the buffered bar describes the blob, not the network.
  `videoIntent("fullscreen")` promotes the canvas HOST element (the whole
  painted app): the accessibility mirror — a sibling of the canvas in
  `<body>` — is outside that fullscreen subtree, so assistive tech loses the
  mirrored tree while fullscreen is active, and the backing store is not
  re-sized on entry, so the app is scaled up rather than re-laid-out until
  the host resizes the canvas.
- **Android**: `STATE_READY` with `playWhenReady` suppressed by audio focus
  reads `paused` (play was requested and the system stopped it) — Media3
  suppression has no cross-platform analogue. The Scrubber polls at 50 ms
  while visible rather than per-frame. `videoIntent("fullscreen")` promotes
  the container into a full-window dialog with immersive system bars,
  re-parenting the one live `PlayerView` (the `ExoPlayer` is never touched,
  so position, buffer and play intent carry through) — but the slot
  subtrees are re-composed by the move, so Compose-side state inside a slot
  resets on entry and exit; engine state does not. A tagged node's
  `.onLongClick` is swallowed by the intent's click handler.
- **iOS**: a `src`/`playlist`/`headers` change rebuilds the player view
  identity — slot children keep their engine state but SwiftUI-side view
  state resets. End-of-item is folded from a racing `.paused` status via a
  0.5 s end tolerance. `videoIntent("fullscreen")` presents the container in
  a `.fullScreenCover` hosting the same `AVPlayer` and manager (playback is
  unbroken); the in-page surface is a placeholder while covered, the cover's
  slot subtrees are a fresh SwiftUI tree (same view-state reset as above),
  the status bar stays visible over the cover, and a source change while
  fullscreen rebuilds the identity and therefore leaves fullscreen. On macOS
  — no `.fullScreenCover` — the intent is inert.
