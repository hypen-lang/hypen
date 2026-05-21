# hypen-renderer-desktop

Native desktop renderer for Hypen.

## Status: Phase 15 (tw breakpoints + SVG icon rasterisation)

The renderer drives a real `hypen-server::ModuleInstance<S>` through the
standard SDK lifecycle (`instantiate` → `on_patches` → `mount` → click →
`dispatch_action` → patches → repaint). Stack:

- **winit 0.30** — windowing + event loop
- **wgpu 29** — surface + present (CPU pixmap → texture → fullscreen blit)
- **tiny-skia 0.12** — CPU 2D rasteriser
- **cosmic-text 0.19** — font shaping + glyph rasterisation

Vello is the eventual GPU rasteriser of choice but is still pinned to wgpu 28;
when it catches up to wgpu 29 it slots in behind the existing `Painter` trait
without touching the rest of the crate.

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
