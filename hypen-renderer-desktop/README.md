# hypen-renderer-desktop

Native desktop renderer for Hypen.

## Status: Phase 4 (text wrapping + keyboard nav + focus ring + tests)

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

## What works (additions in Phase 4)

- **Text wrapping** — cosmic-text reshapes against the rect width Taffy
  hands it; long Text inside a narrow Column wraps and the Column grows
  vertically.
- **Keyboard navigation** — Tab walks actionables in document order,
  Shift+Tab walks back, Enter / Space dispatches the focused action,
  Escape clears focus. Focus also clears on window blur.
- **Native focus ring** — 3px outset, 2px stroke, system-accent blue
  (`#007aff` at 80% alpha) painted above all other content.

## Tests

53 unit tests in the renderer + 8 SDK integration tests. Run them with:

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

- Borders, margins, gradients, transforms, `.tw` classes — Phase 5.
- IME / text input — Phase 5.
- AccessKit (screen readers, voice control) — Phase 5.
- Custom titlebar + `.hypen` file loader + bundling story — Phase 6.

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
