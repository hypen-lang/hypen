# hypen-renderer-desktop

Native desktop renderer for Hypen.

## Development performance HUD

Build with `--features dev-overlay` to paint a native, non-interactive HUD over
the final scene showing process CPU and resident RAM plus the last rendered
frame's cost and its equivalent continuous FPS. Hypen is demand-driven, so an
idle window keeps its last frame measurement instead of reporting a misleading
zero FPS.
It samples once per second without forcing the demand-driven renderer to run
continuously. Production builds do not include the sampler dependency or HUD.

## Status: Phase 15 (tw breakpoints + SVG icon rasterisation)

The renderer drives a real `hypen-server::ModuleInstance<S>` through the
standard SDK lifecycle (`instantiate` → `on_patches` → `mount` → click →
`dispatch_action` → patches → repaint). Stack:

- **winit 0.30** — windowing + event loop
- **wgpu 29** — GPU device, surface, and presentation
- **Vello 0.10** — GPU 2D rasteriser with a persistent image atlas
- **tiny-skia 0.12** — off-screen image and icon-mask work
- **cosmic-text 0.19** — font shaping + glyph rasterisation

> **Animation.** This renderer has full parity with the DOM renderer across the
> `__anim.*` channel (transitions, enter/exit, FLIP layout, presets, states,
> shared elements, scrub/settle, completion events, `animate:` transactions).
> The authoritative capability matrix — what plays and the recorded narrowings
> (uniform scale, `shimmer` snap, transform-only shared elements, single-cursor
> scrub, env-gated reduced motion) — lives in the module docs of
> [`src/anim.rs`](src/anim.rs).

## What works today

- Window opens on macOS / Linux / Windows (winit).
- Tree mirrors the engine via `Create / SetProp / RemoveProp / Insert / Move / Remove`.
- **Taffy 0.10** flex layout: `Column`, `Row`, `Container`, `Text`, `Button`,
  with renderer node ↔ Taffy node mapping kept in sync each frame.
- **Style applicators** read from props: `.padding(N)` (and the directional
  variants), `.gap(N)`, `.fontSize(N)`, `.color(...)`, `.backgroundColor(...)`,
  `.borderColor(...)`. Colours accept CSS hex (`#rgb` / `#rgba` / `#rrggbb` /
  `#rrggbbaa`) and ~15 named colours.
- **Hover + press states**: actionables tint up on hover and darken while
  the mouse button is held. Releasing outside the original target cancels
  the action (matches native button semantics).
- Hit-testing on left-mouse-up dispatches the action in `props.action`
  (the engine's resolved form of `Button("@actions.X")`).
- Patches flushed every frame; `about_to_wait` requests a repaint whenever
  the SDK pushes patches between events (e.g. async actions).

## Charts

The `Chart` family renders natively: `chart` hosts the coordinate space and
`line`, `area`, `bars`, `points`, `axis`, `rule`, `marker` and `path` are its
marks. Domains, nice ticks, insets, mark geometry and event-payload
resolution live in [`src/chart.rs`](src/chart.rs) as pure functions over
plain data (the `paint::image::scrubber_geometry` pattern), so the Vello
painter only walks a device-pixel draw list and the hit-tester only consults
the resolved marks.

- **Layout.** A chart is a leaf-like block — 200 logical px tall by default,
  width fills the parent, `.width()` / `.height()` override. Marks are laid
  out BY the chart, not by Taffy; the one exception is `Marker`, whose
  ordinary Hypen children are real layout items pinned to their data point
  per the anchor rule (`top` by default, 8px clear of the point). A `Marker`
  with neither coordinate emits nothing at all.
- **Interaction.** `.onClick` / `.onPress`, `.onLongPress` (500 ms),
  `.onHover`, `.onMove` (throttled to ~32 ms) and `.onMouseLeave` on a mark
  dispatch `{series, index, x, y, datum}` in DATA units, merged on top of the
  applicator's static arguments. A bar, a point or a line vertex resolves
  that row (vertices and points carry an invisible 12px touch target); any
  other hit on a data mark resolves the row nearest the pointer along x.
  Events on the `Chart` itself carry the pointer position in data units.
  A mark with NO event applicator emits no layout item, so it is transparent
  to the pointer — a tooltip's `Points` / `Marker` can never steal the
  pointer from the `Line` underneath.
- **Reactivity.** The chart family opts out of the paint-only fast path
  (`chart::is_chart_family_node`): a mark's `points` / `stroke` /
  `highlight` are not layout props by the shared classifier's reckoning, but
  they resolve domains and geometry, so any prop change on a chart or a mark
  re-lays the whole chart out.

> **Recorded narrowing — glow / mark shadows.** `glow(...)` (and the
> `shadow` / `boxShadow` / `elevation` family, which mean a *shape* shadow on
> a mark) is approximated with three progressively wider, lower-alpha strokes
> behind the geometry, not a real Gaussian blur. Vello's only blur primitive
> is `draw_blurred_rounded_rect`, which cannot take an arbitrary path; the
> stroke stack reads as a soft halo and costs three extra encoded paths.
> Revisit if Vello grows a path-blur primitive.

## Device capabilities (RFC 001)

In remote mode the desktop is a **DeviceHost** for the Device Capability
Protocol (`rfcs/001-device-capability-protocol.md`): a server handler calls
`context.device.request(...)` and the desktop runs it, behind host-owned
consent UI. `RemoteModule::connect` / `DesktopApp::connect` attach the native
host (`DeviceConfig::native()`) by default.

| Capability | Desktop | Cargo feature |
|---|---|---|
| `core.capabilities@1` | always (the host itself) | — |
| `file.pick@1` | OS open dialog (multi-select up to `maxCount`, `accept` → file-type filter); files stream lazily from disk as the server grants credit | — |
| `gallery.pick@1` | OS open dialog filtered to image / video types per `mediaTypes` | — |
| `file.save@1` | OS save dialog, then a credit-paced download (≤ 256 KiB window) into a temp file beside the destination, renamed into place only after size and SHA-256 verify; deleted on failure / cancel / disconnect | — |
| `camera.capture@1` | in-window capture panel with a live preview. **Photo**: Capture → one `image/jpeg` item (declared size). **Video**: Record → Stop; H.264 in a *fragmented* MP4 (`video/mp4`), streamed fragment by fragment as it is encoded, without a declared size. Video has **no audio track** on the desktop (no bundled AAC/Opus encoder), so it needs no microphone | `camera` |
| `mic.record@1` | consent dialog, then a recording indicator (origin, elapsed time, Stop) for the whole recording; one `audio/L16` item — little-endian PCM16 at the requested `sampleRate`, interleaved when `channels: 2` — streamed as captured, without a declared size; result `{durationMs, item}` | `mic` |
| `bluetooth.scan@1` | consent dialog (remembered 24 h for a `wss://` origin, for the connection on `ws://`), then a scanning indicator with Stop; coalesced `{device:{id,name?,rssi}}` events | `bluetooth` |
| `bluetooth.select@1` | in-window chooser listing a live scan filtered by `services` (a device must advertise every one) and `namePrefix` (exact code points); a row → `{device:{id,name?}}` | `bluetooth` |
| `permission.query@1` / `permission.request@1` | the OS permission model (below); `request` only prompts where the OS would (macOS), behind a host consent dialog | — |

The advertisement follows the RFC's rule: only what this build implements
and can present — file capabilities need a dialog backend, the others the
in-window host UI (both need a display: no display → nothing but
`core.capabilities`) and their backend. With a feature compiled out
(`default-features = false`) its capabilities are not advertised, so
`supports()` is false and a request is `unsupported`. Hardware is detected at
request time (cameras and headsets come and go), so a machine without it
answers `unavailable` — `no-camera`, `no-microphone`, `no-adapter`,
`adapter-off` — never a panic or a hang. `DeviceConfig::with_dialogs(...)` is
the file-dialog-only host; `.with_capture(ui, Hardware { .. })` adds capture
drivers behind any UI / backends (the tests use scripted fakes).

### What the user sees

All device UI is **host UI drawn by the renderer over the app** (after every
app item, so the app's patch tree can neither cover nor restyle it), named
with the server's origin and host-defined text only:

- **Modal surfaces** — the consent dialog (Continue / Cancel), the camera
  panel (preview; Capture, or Record then Stop; Cancel) and the Bluetooth
  chooser (device rows; Cancel) — dim the window and take every pointer and
  key event while shown: app clicks and keys neither reach the app nor
  activate the surface. One device prompt at a time (another request is
  `throttled`).
- **Indicators** — microphone recording and BLE scanning — are pills in the
  top-right corner with the origin, the activity, the elapsed time and a
  Stop button, up for exactly as long as the hardware runs. The app stays
  usable around them.
- **Input protection** (as in the web host): Continue / Capture / Record /
  Stop / chooser rows ignore input for 500 ms after they appear and after the
  window regains focus; only a press that started on the enabled control, or
  a fresh (non-repeated) Enter/Space on the focused one, activates it. A
  modal opens with focus on Cancel.
- **Keyboard**: Tab / Shift+Tab between controls, Enter / Space to activate,
  Up / Down through the chooser, Escape to cancel (on a consent dialog Escape
  is abandonment → `cancelled`; the Cancel button is a refusal → `denied` with
  a 30 s cooldown). Without a modal, **F6** moves focus into the indicators
  (Tab cycles their Stop buttons; Escape / F6 returns to the app).
- **Screen readers** (AccessKit): a modal is a `Dialog` (modal) with its text,
  its buttons (disabled while input-protected) and, for the chooser, a
  `ListBox` of options; an indicator is a `Status` with a "Stop: …" button.
  Click / Focus actions from assistive tech behave like the keyboard.
- **Window hidden** (minimized or closed): the indicators cannot be
  seen, so a microphone or camera recording **stops normally** (success with
  what was captured) and a BLE scan ends `cancelled` (`indicator-hidden`);
  modal prompts stay pending and re-arm when the window shows again. A window
  that is only covered by another one (or on another Space) is not hidden:
  device work continues and the user brings the window forward to reach Stop.

Outcomes: capture-panel / chooser Cancel → `cancelled` (`capture-dismissed` /
`chooser-dismissed`); consent Cancel → `denied` (`host-refused`); OS refusal →
`denied` (detail = the permission); Stop, `maxDurationMs` or the 64 MiB item
cap end a recording **normally**; server cancel, deadline, lease loss and
disconnect end it with the usual error and release the hardware at once.
When the server stops granting credit, captured bytes wait in a bounded
window (1 MiB audio, 8 MiB video), after which the recording ends
`throttled` (`capture-buffer-full`). Bluetooth device ids are **opaque**: a
UUID-shaped keyed hash of (per-install secret, server origin, platform id) —
stable for one origin on one machine, unlinkable across origins, never the
MAC address (iOS and the web expose per-app / per-origin ids too).

### Backends and build requirements

| Feature | Crate | Linux | macOS | Windows |
|---|---|---|---|---|
| `camera` | [`nokhwa`](https://crates.io/crates/nokhwa) (no `decoding`; MJPEG / YUYV / NV12 converted in-crate) + [`openh264`](https://crates.io/crates/openh264) built from its bundled source + an in-crate fragmented-MP4 muxer | V4L2; build: `libclang-dev` (bindgen for the V4L2 headers), a C++ compiler | AVFoundation | Media Foundation; build: MSVC C++ |
| `mic` | [`cpal`](https://crates.io/crates/cpal) | ALSA (reaches PulseAudio / PipeWire through their ALSA plugins); build: `libasound2-dev`, `pkg-config` | CoreAudio | WASAPI |
| `bluetooth` | [`btleplug`](https://crates.io/crates/btleplug) | BlueZ over D-Bus (`bluetoothd` running); build: `libdbus-1-dev`, `pkg-config` | CoreBluetooth | WinRT |

Ubuntu / Debian: `sudo apt-get install -y pkg-config libasound2-dev
libdbus-1-dev libclang-dev g++` (plus the usual winit headers). `nasm` is
optional (OpenH264 uses its assembly kernels when it is on `PATH`; without it
the encoder falls back to C). Everything else — JPEG encoding (`image`), MJPEG
decoding, PCM conversion and resampling, MP4 muxing — is pure Rust. OpenH264
from source is BSD-licensed code, but H.264 itself is patent-encumbered:
Cisco's royalty coverage applies only to its prebuilt binaries, so products
shipping this encoder should check their licensing position (or build with
`default-features = false` and re-enable only `mic` / `bluetooth`).

**macOS app bundles** must declare `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription` and `NSBluetoothAlwaysUsageDescription` in
their `Info.plist` (the OS terminates a bundled app that touches the hardware
without them). The host checks this first and answers `unavailable`
(`not-declared:camera` …) instead of crashing; a binary run from a terminal
is covered by the terminal's own permission.

### Permissions (`permission.query` / `permission.request`)

| Permission | macOS | Windows | Linux |
|---|---|---|---|
| `camera` | TCC (`AVCaptureDevice` authorization); `prompt` when undetermined | Settings › Privacy › Camera (ConsentStore `webcam`): `denied` when off, else `granted` | no per-app model: `denied` only when every `/dev/video*` node refuses this user, else `granted` |
| `microphone` | TCC (audio) | Settings › Privacy › Microphone | `granted` (no per-app model) |
| `bluetooth` | `CBManager.authorization` | `granted` (no desktop-app gate) | `granted` (BlueZ admits the session user) |
| `photos` | `granted` (the file dialog needs no permission) | `granted` | `granted` |
| `location`, `notifications`, `contacts` | `unsupported` (no desktop driver) | `unsupported` | `unsupported` |

A capture whose OS permission is `denied` fails `denied` before any UI; an
undetermined one (macOS) shows the OS prompt first.

Device-enabled servers admit a native client (no `Origin`) only through their
authenticator, so pass the credential as an upgrade header:

```rust
use hypen_renderer_desktop::{DesktopApp, RemoteOptions};

DesktopApp::new()
    .connect_with(
        "wss://app.example.com/ws",
        "App",
        RemoteOptions::default().header("Authorization", "Bearer …"),
    )
    .run();
```

`RemoteOptions::device(None)` connects UI-only; `DeviceConfig::with_dialogs`
swaps the dialogs (tests, kiosks). The client also keeps the server's
rotating `resumeToken` and presents it when it reconnects.

**In-process mode** (`DesktopApp::module(...)` with a local `ModuleInstance`)
has no connection and therefore no device plane: `ctx.device()` answers every
call `unavailable` (`device-disabled`) and `supports()` is false. For device
work, run the module behind a device-enabled server — the Rust SDK's
`RemoteSession` can run in the same process on `localhost` — and connect.

The protocol core (`src/device/host.rs`) is sans-IO and mirrors the iOS /
Android hosts rule for rule; it never panics on server input. Malformed or
unattributable device text and bad frame headers are counted as
connection-level violations (the socket is reset only after 32), a message
that breaks a live request's rules terminates that request with
`invalidParams`, everything for an unknown id is ignored — and none of it
touches the patch path. Patch batches are also decoded patch by patch (one
malformed patch is skipped, not the batch), unknown message types are
ignored, and the tree refuses patches that would create a cycle. Tests:
`src/device/tests.rs`, `tests/device_transcripts.rs` (every shared wire
transcript replayed with the desktop as the client), `tests/device_rust_server.rs`
(a real Rust SDK server and a hostile server over real WebSockets) and
`tests/device_ts_server.rs` (the TypeScript `RemoteServer` through bun). The
capture drivers are tested without hardware or a display through fake
camera / microphone / Bluetooth / permission backends and a scripted host UI
(`src/device/capture_tests.rs`: consent granted / refused / dismissed, cancel
mid-recording, `maxDurationMs`, credit starvation, blob framing and SHA-256,
no-hardware errors, Bluetooth filters and opaque ids, video as fragmented
MP4, indicator lifetime = hardware lifetime); the overlay's layout, input
protection, keyboard and AccessKit tree in `src/device/overlay.rs`; PCM
conversion, the MP4 muxer, JPEG / MJPEG / YUV conversion and the real H.264
encoder in their modules.

## What works (additions in Phase 15)

- **Tailwind breakpoints** via `prop_*_at(node, name, viewport_w)`
  variants. Layout threads viewport width into every prop read so
  `padding@md`, `backgroundColor@lg`, etc. resolve against the live
  surface size. Largest-active breakpoint wins (sm < md < lg < xl <
  2xl); base + dotted + kebab fallback chain still applies underneath.
- **SVG `Icon` rasterisation.** The engine pre-resolves
  `Icon(@resources.heart)` into structured `paths` + `viewBox` props
  (each path carries `d`, `fill`, `stroke`, `strokeWidth`,
  `stroke{linecap,linejoin}`). The renderer reads them, parses each
  `d` via `svgtypes`, builds a `tiny-skia` path, and fills + strokes
  with a uniform-scale + centring transform. Lucide-style outline
  icons (most of the bundled apps) render with crisp anti-aliased
  strokes; filled icons honour their fill colour. `.color(red)` on
  an Icon flows through as a global tint that overrides per-path
  fill/stroke colours.

## What works (additions in Phase 14)

- **HTTP / HTTPS image loading** — Phase 13's local-only cache
  promotes to a `Loading | Loaded | Failed` state machine. Remote
  URLs (Instagram avatars, etc.) queue on a single dedicated
  worker thread that fetches via `ureq` and decodes via `image`.
  Worker fires an `AppEvent::Wake` through the renderer's
  `EventLoopProxy` when a load lands so the next paint picks up
  the bitmap. 10s timeout per request, 20MB body cap.
- **Reconnect-with-backoff** for `RemoteModule`. The worker now
  loops on disconnect with exponential backoff (1s → 2s → 4s → … →
  capped at 30s, hard-capped at 60 attempts). `SessionAck`'s
  `sessionId` is captured and replayed in the next `Hello`, so
  the server can resume rather than mint a fresh session every
  time bun's hot-reload restarts. `SessionExpired` clears the
  stored id so the next attempt mints fresh instead of re-failing.

## What works (additions in Phase 13)

- **Local image loading** + `Image` / `Icon` element types,
  `textAlign` (start / center / end), and a gray rounded
  placeholder for missing or in-flight image sources.

## What works (additions in Phase 11)

- **Remote mode** — `DesktopApp::new().connect(url, module_name).run()`
  opens a WebSocket to a Hypen `RemoteServer` and streams the standard
  `RemoteMessage` protocol (`Hello` / `SessionAck` / `InitialTree` /
  `Patch` / `DispatchAction`). The renderer doesn't change behaviour:
  the same `HypenModule` trait that wraps the in-process Rust SDK
  also wraps the network client, so paint / layout / hit-test /
  AccessKit / IME all work unchanged.
- A worker OS thread owns its own `current_thread` tokio runtime so
  the (sync) winit event loop stays sync. Patches arrive on the worker,
  flow through an `Arc<Fn(&[Patch]) + Send + Sync>` callback, and land
  in the same `PatchQueue` the local SDK module uses.
- A connect-race buffer ensures the `InitialTree` isn't lost if it
  arrives before `on_patches` is wired (the renderer drains pending
  patches the moment the callback is set).
- Example: `cargo run -p hypen-renderer-desktop --example remote`
  connects to `ws://localhost:3000` (module `App`); pass `URL MODULE`
  on the command line to override.

### WebSocket compression (`permessage-deflate`)

**The desktop client does not offer compression.** Hypen turns
`permessage-deflate` on by default in its other SDKs, but this renderer's
WebSocket client (`tokio-tungstenite`, pinned at 0.24) cannot negotiate it —
so we send no `Sec-WebSocket-Extensions` offer and the patch stream travels
uncompressed.

This is a hard ecosystem limitation, not a configuration we skipped. No
published `tungstenite` / `tokio-tungstenite` release up to and including
0.30.0 exposes a `deflate` (or any compression) feature, and none depends on a
compression crate; the `tungstenite` README still says *"There is no support
for permessage-deflate at the moment"*. Upstream issue
[snapview/tungstenite-rs#2](https://github.com/snapview/tungstenite-rs/issues/2)
has been open since 2017 — an implementation merged as
[#328](https://github.com/snapview/tungstenite-rs/pull/328) and was reverted,
and the re-land ([#426](https://github.com/snapview/tungstenite-rs/pull/426))
is still unmerged. There is therefore no version bump that would enable it, and
the dependency is deliberately left untouched.

**It interoperates fine either way.** `permessage-deflate` is negotiated per
connection and optional under RFC 7692: this client makes no offer, so a
compression-enabled Hypen server has nothing to accept and both peers speak
plain frames. Pointing the desktop renderer at a server that happily compresses
for browser or Android/OkHttp clients works unchanged — the desktop connection
simply pays full bandwidth. The cost is bytes, not correctness.

Re-check this on any `tokio-tungstenite` bump: if
[#426](https://github.com/snapview/tungstenite-rs/pull/426) lands, enable the
`deflate` feature and offer the extension at the `connect_async` call in
`src/remote.rs`.

## What works (additions in Phase 10)

- **IME composition** wired through `winit`'s `Ime` event:
  - `set_ime_allowed(true)` toggles when an `Input` is focused;
    `set_ime_cursor_area` follows so the candidate window positions
    near the focused field.
  - `Preedit` text is stored as `Option<(node_id, text)>` and rendered
    inline at the caret with a 1px accent-blue underline so the user
    sees what they're composing isn't yet committed.
  - `Commit` flows through the same `replace_selection_with` primitive
    as plain typing, so a non-empty selection is replaced by the
    committed text and the caret advances.
  - `Disabled` clears state cleanly.
- Pure state-machine extracted to `apply_ime_transition` so the
  Enabled / Preedit / Commit / Disabled transitions can be tested
  without spinning up an `App`.

## What works (additions in Phase 9)

- **Selection** in `Input` — `Selection { anchor, head }` per Input
  with click-to-position, mouse-drag-to-select, Shift+ArrowLeft /
  ArrowRight / Home / End to extend.
- **System clipboard** via `arboard`: Ctrl/Cmd + A select-all, +C
  copy, +X cut, +V paste. Newlines in the clipboard collapse to
  spaces for single-line `Input` (`Textarea` will preserve them later).
- **Editing primitives** are selection-aware: typing replaces the
  selected range; Backspace / Delete with a non-empty selection
  delete the range; collapsed selections fall back to per-codepoint
  edits (so multibyte text still walks correctly).
- **Painter selection band** — translucent accent-blue rectangle from
  `min` to `max` byte offset; the caret only paints when the selection
  is collapsed.
- **Real production bug fixed by tests**: `text::draw_text_colored`
  used to ignore source alpha because cosmic-text's swash glyph path
  overwrites the colour's alpha byte with per-pixel coverage — so
  `Rgba::TRANSPARENT` still mutated the pixmap. Now short-circuited
  at the source. Regression test in place.

## What works (additions in Phase 8)

- **Page scrolling.** Mouse wheel (line + pixel deltas — trackpads
  work) scrolls the whole page vertically.
- `LayoutPass::compute_with_scroll(.., scroll_y)` subtracts the offset
  from every emitted item; hit-test, paint, and AccessKit see a single
  consistent set of rects without needing extra translation logic.
- Scroll offset is clamped against the live content size (auto-corrects
  when the page shrinks under you due to a state change).
- Thin gray indicator bar on the right edge tracks position and is
  proportional to the visible fraction. Hidden when content fits.

## What works (additions in Phase 7)

- **`Input` element** with two-way state binding via `.bind(@state.x)`:
  - Click an Input to focus it; Tab walks Inputs alongside Buttons.
  - Printable characters insert at the caret (cross-layout via
    `KeyEvent.text` so dead keys + alt-graph layouts work).
  - Backspace / Delete remove around the caret; ArrowLeft / ArrowRight
    move it; Home / End jump; Escape blurs.
  - Each mutation dispatches `__hypen_bind { path, value }` — the SDK's
    reserved action — which writes back into module state. The engine
    re-renders, the Input's `value` prop updates via `SetProp`, and the
    layout shows the new text. Round-trip is synchronous.
  - Caret is a 1.5-px accent-blue bar; placeholder paints muted gray.
  - UTF-8-safe cursor stepping (multi-byte codepoints + emoji walk as
    units, never split mid-codepoint).
  - Inputs announce as `Role::TextInput` to AccessKit with their value
    + placeholder as the accessible label.

## What works (additions in Phase 6)

- **AccessKit integration** — full accessibility tree published via
  `accesskit_winit`. NVDA / VoiceOver / Orca read every Text, Button,
  and Input; Buttons can be triggered through `Action::Click`, which
  routes through the same `instance.dispatch_action(...)` path mouse
  and keyboard use.

## What works (additions in Phase 5)

- **Borders + margins** as full applicators (`.border`, `.borderWidth`,
  `.borderColor`, `.borderRadius`, `.cornerRadius` alias; `.margin` +
  all the directional variants padding has).
- Background + border apply to every element type, not just `Button`.

## What works (kept from earlier phases)

- **Text wrapping** — cosmic-text reshapes against the rect width Taffy
  hands it; long Text inside a narrow Column wraps and the Column grows
  vertically.
- **Keyboard navigation** — Tab walks actionables in document order,
  Shift+Tab walks back, Enter / Space dispatches the focused action,
  Escape clears focus. Focus also clears on window blur.
- **Native focus ring** — 3px outset, 2px stroke, system-accent blue
  (`#007aff` at 80% alpha) painted above all other content.

## Tests

175 unit tests in the renderer + 8 SDK integration tests. Run them with:

```bash
cargo test -p hypen-renderer-desktop --lib
cargo test -p hypen-server --tests
```

Coverage: `Tree` patch application, `LayoutPass` flex + hit-testing +
focus traversal, text wrap measurement + click-to-byte hit-test, style
helpers (color / length / padding precedence), the painter's
color-math + selection-band logic, and the `Selection` /
`replace_selection_with` primitives that drive Input editing. The
window/event-loop layer is not unit-tested directly — its branches
delegate to `LayoutPass::hit` / `focus_next` / `replace_selection_with`,
which are covered.

## What does **not** work yet

- `Textarea`, `Checkbox`, `Switch`, `Select` (only `Input` so far).
- Word-wise navigation (Ctrl+arrows) + double-click-to-select-word +
  triple-click-to-select-line.
- Per-Container scroll (only the whole page scrolls today). Inner
  scrollables — a list inside a sidebar — land later when we expose
  Taffy's overflow style.
- Image / Icon elements; gradients; transforms; `.tw` tailwind classes.
- AccessKit focus tracking inside the window (kbd Tab focus is
  rendered locally; we don't yet sync it to AccessKit's `focus` field).
- Custom titlebar + `.hypen` file loader + bundling story.

## Run the demos

```bash
# Static "Hello" (Column + 3 Text nodes)
cargo run -p hypen-renderer-desktop --example hello

# Counter — clicks +/- to change a counter, demonstrates the full
# click → action → state → repaint loop
cargo run -p hypen-renderer-desktop --example counter

# Input — two-way binding, drag-select, Cmd/Ctrl+A/C/X/V, IME compose
cargo run -p hypen-renderer-desktop --example input

# Scroll — long Column with overflow indicator
cargo run -p hypen-renderer-desktop --example scroll

# Remote — connect to a running Hypen RemoteServer.
# Start a server first; e.g. the bundled social example:
#   cd examples/social/typescript && bun install && bun run dev
# Then in another terminal:
cargo run -p hypen-renderer-desktop --example remote
# Or override URL + module name explicitly:
cargo run -p hypen-renderer-desktop --example remote -- ws://localhost:3000 App
```

## SDK contract used by this renderer

`ModuleInstance::new` parses the UI source but does **not** render. The initial
`render_ir_node` is deferred to `mount()`, so callers can wire `on_patches(cb)`
in between and capture the initial Create batch. This contract is shared with
any other Rust SDK consumer.
