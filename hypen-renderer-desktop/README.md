# hypen-renderer-desktop

Native desktop renderer for Hypen.

## Status: Phase 8 (page scrolling + overflow indicator)

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

88 unit tests in the renderer + 8 SDK integration tests. Run them with:

```bash
cargo test -p hypen-renderer-desktop --lib
cargo test -p hypen-server --tests
```

Coverage: `Tree` patch application, `LayoutPass` flex + hit-testing +
focus traversal, text wrap measurement, style helpers (color / length /
padding precedence), and the painter's color-math primitives. The
window/event-loop layer isn't unit-tested directly — its logic delegates
to `LayoutPass::hit` / `focus_next` / `focus_prev`, which are covered.

## What does **not** work yet

- IME composition (CJK, dead keys with combining marks).
- `Textarea`, `Checkbox`, `Switch`, `Select` (only `Input` so far).
- Selection (mouse drag, Shift+arrows) + clipboard (Ctrl+C / V / X) +
  word-wise navigation (Ctrl+arrows).
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
```

## SDK contract used by this renderer

`ModuleInstance::new` parses the UI source but does **not** render. The initial
`render_ir_node` is deferred to `mount()`, so callers can wire `on_patches(cb)`
in between and capture the initial Create batch. This contract is shared with
any other Rust SDK consumer.
