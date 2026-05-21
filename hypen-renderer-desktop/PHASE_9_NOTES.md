# Phase 9 — Selection + Clipboard for `Input`

> Continuation notes for the next agent. Read `README.md` first for the
> renderer's overall architecture; this doc covers only what's needed to
> finish Phase 9.

## Where we are

Tree state at this doc's HEAD (commit `cf93322`):

- 103 unit tests pass; `cargo clippy --all-targets --no-deps` is clean.
- Test backfill landed: `text.rs` (8 tests), `paint/cpu.rs` (13),
  `module.rs` (3), `layout.rs` (26).
- `draw_text_colored` was caught swallowing source alpha — fixed by an
  early `if color.3 == 0 { return; }` guard. Regression test asserts
  byte-identical pre/post on a transparent draw.

**Phase 9 prep already on `main`:**

- `Cargo.toml` — `arboard = "3"` dep added (no consumer yet).
- `text.rs` — `TextEngine::byte_offset_at_x(text, target_x, font_size)`
  added: walks every char-boundary + end-of-string, returns the byte
  offset whose leading-substring width is closest to `target_x`. Used
  for click-to-position-cursor on Inputs.

**Phase 9 work itself: not yet implemented.** The previous attempt
collided with a parallel test-backfill agent that reverted the WIP
because it didn't compile mid-edit. Don't repeat that — see
[Process traps](#process-traps) below.

## Goal

`Input(placeholder: ...).bind(@state.x)` should support what users expect
of any text field on a desktop OS:

| Capability                              | UX                                            |
| --------------------------------------- | --------------------------------------------- |
| Click positions the cursor at click x   | Already partially: today click puts caret at end |
| Click-and-drag selects a range          | New                                           |
| Shift + arrows / Home / End extends sel | New                                           |
| Cmd/Ctrl + A selects all                | New                                           |
| Cmd/Ctrl + C copies selection           | New                                           |
| Cmd/Ctrl + X cuts                       | New                                           |
| Cmd/Ctrl + V pastes (replace selection) | New                                           |
| Backspace / Delete / typing on a selection replaces it | New                       |
| Visible selection band                  | New                                           |

Skip for this phase (each is its own scope):

- IME composition (CJK / dead keys with combining marks).
- `Textarea` multi-line editing.
- Word-wise navigation (Cmd/Ctrl + arrows).
- Double/triple-click to select word/line.
- Selection drag-to-extend after the first click.

## API contract refresher

The engine resolves `Input(placeholder: "Name").bind(@state.name)` into
two props on the `Input` element:

- `value = "@{state.name}"` — a binding the engine evaluates each render.
- `bind = "name"` — the dotted state path the renderer dispatches against.

When the user mutates the field the renderer dispatches:

```
__hypen_bind { path: "name", value: "<new full text>" }
```

The SDK applies the value back to module state, the engine re-renders,
and a `SetProp(value, ...)` patch flows back synchronously. The
renderer's tree mirror picks up the new value automatically; the local
editor only needs to remember **selection state** between events.

## Design

### `Selection` (in `window.rs`)

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub anchor: usize, // byte offset
    pub head:   usize, // byte offset (caret position)
}

impl Selection {
    pub fn caret(at: usize) -> Self { /* anchor == head == at */ }
    pub fn range(anchor: usize, head: usize) -> Self;
    pub fn min(self) -> usize;        // anchor.min(head)
    pub fn max(self) -> usize;        // anchor.max(head)
    pub fn is_collapsed(self) -> bool;
    pub fn clamped(self, max: usize) -> Self;
}
```

Replace the existing `App.input_cursors: HashMap<String, usize>` with
`App.input_selections: HashMap<String, Selection>`. The painter's
`InteractionState.input_cursors` likewise becomes `input_selections`.

### App fields to add

```rust
struct App {
    // existing...
    input_selections: HashMap<String, Selection>,
    /// Renderer node id of the Input being drag-selected. Some(id)
    /// between mouse-down inside the input and the next mouse-up.
    dragging_input: Option<String>,
    /// Lazy system clipboard. Created on first copy / paste.
    clipboard: Option<arboard::Clipboard>,
}
```

Helpers:

```rust
fn clipboard_modifier(&self) -> bool {
    // Linux/Windows = Ctrl, macOS = Cmd. Accept either so muscle
    // memory works on any host.
    self.modifiers.control_key() || self.modifiers.super_key()
}

fn clipboard_get(&mut self) -> Option<&mut Clipboard> {
    if self.clipboard.is_none() {
        self.clipboard = Clipboard::new().ok();
    }
    self.clipboard.as_mut()
}
```

### Editing primitives

```rust
fn selection_of(&self, id: &str, value: &str) -> Selection {
    self.input_selections
        .get(id).copied()
        .unwrap_or_else(|| Selection::caret(value.len()))
        .clamped(value.len())
}

/// Apply mutate(value, sel) -> (new_value, new_sel). Dispatches
/// __hypen_bind only when value changed; updates selection regardless.
fn edit_focused_input<F: FnOnce(&str, Selection) -> (String, Selection)>(
    &mut self,
    mutate: F,
) -> bool;

/// Replace [sel.min..sel.max] with `replacement`, returning a new
/// value + collapsed Selection at lo + replacement.len().
fn replace_selection_with(value: &str, sel: Selection, replacement: &str)
    -> (String, Selection);
```

### Mouse handling

`MouseInput::Pressed { Left }` on an Input:

1. Compute `byte_offset = text_engine.byte_offset_at_x(value, cursor.x - text_x, font_size)`
   where `text_x = item.rect.x + 12px_pad * scale`.
2. Set `input_selections[id] = Selection::caret(byte_offset)`.
3. Set `self.dragging_input = Some(id)`.

`CursorMoved` while `dragging_input == Some(id)`:

1. Compute `byte_offset` as above.
2. Update only the `head`: `input_selections[id].head = byte_offset`
   (anchor stays).

`MouseInput::Released { Left }`:

1. `self.dragging_input = None`.

For non-Input clicks the existing actionable path stays unchanged.

### Keyboard handling

`handle_keyboard` extension. When the focused element is an Input:

| Key                    | Effect                                                    |
| ---------------------- | --------------------------------------------------------- |
| Backspace              | If selection: delete it. Else: delete prev codepoint.     |
| Delete                 | If selection: delete it. Else: delete next codepoint.     |
| ArrowLeft  (no shift)  | Collapse to `min` if range; else step `head` left.        |
| ArrowLeft  (shift)     | Step `head` left, keep `anchor`.                          |
| ArrowRight (no shift)  | Collapse to `max` if range; else step `head` right.       |
| ArrowRight (shift)     | Step `head` right, keep `anchor`.                         |
| Home (no shift)        | Caret at 0.                                               |
| Home (shift)           | `head = 0`, keep `anchor`.                                |
| End (no shift)         | Caret at `value.len()`.                                   |
| End (shift)            | `head = value.len()`, keep `anchor`.                      |
| Cmd/Ctrl + A           | Select all.                                               |
| Cmd/Ctrl + C           | Copy selection (no-op if collapsed).                      |
| Cmd/Ctrl + X           | Cut: copy then delete.                                    |
| Cmd/Ctrl + V           | Paste: replace selection (or insert at caret), strip `\n`/`\r`. |
| Printable text         | Replace selection with the typed string.                  |
| Escape                 | Blur (existing behaviour).                                |

### Painter

`paint/cpu.rs::InteractionState` change:

```rust
pub input_selections: HashMap<String, crate::window::Selection>,
// (was: pub input_cursors: HashMap<String, usize>)
```

In the `ItemKind::Input` arm:

1. Look up `Selection` (default `Selection::caret(value.len())`).
2. If `is_collapsed()`: render the existing accent-blue caret at
   `text_x + measure(value[..head]).w`.
3. Else: render a translucent accent band:
   - `band.x = text_x + measure(value[..sel.min()]).w`
   - `band.w = measure(value[sel.min()..sel.max()]).w` (clamp to ≥ 2px)
   - `band.y = text_y`, `band.h = font_size * 1.2`
   - colour `Rgba(0x00, 0x7a, 0xff, 0x55)`
   - paint the band BEFORE the text so glyphs render on top.

## Files to touch (ordered)

1. **`src/window.rs`** — bulk of the work. Single `Write` of the whole
   file is the safest atomic update; the file is ~813 lines.
   - Add `Selection` struct + impls.
   - Replace `input_cursors` field with `input_selections` + add
     `dragging_input` + `clipboard`.
   - Update initializer.
   - Add `clipboard_modifier`, `clipboard_get`, `selection_of`,
     `replace_selection_with`, `copy_focused_selection`,
     `cut_focused_selection`, `paste_into_focused_input`.
   - Rewrite `edit_focused_input` for the `Selection` shape.
   - Rewrite `handle_keyboard` per the table above.
   - Rewrite the `MouseInput::Pressed` branch for click-to-position.
   - Add a `CursorMoved` branch for drag-update.
   - Clear `dragging_input` on `MouseInput::Released`.
   - Update the `about_to_wait` clamp to walk `input_selections`.
   - Add tests at the bottom (see [Tests](#tests-to-add)).

2. **`src/paint/cpu.rs`** — small, focused.
   - Replace `InteractionState.input_cursors` with `input_selections`.
   - In the Input paint arm, draw the band before the text when not
     collapsed; render caret only when `is_collapsed()`.

3. **`examples/input.rs`** — refresh the demo's instructions to mention
   keyboard shortcuts (Tab, Ctrl+A, Ctrl+C/X/V) so users can verify.

## Order of operations

```
1. Edit window.rs              -> cargo build
2. Edit paint/cpu.rs           -> cargo build
3. Add tests in window.rs      -> cargo test --lib
4. Update examples/input.rs    -> cargo build --examples
5. cargo clippy --all-targets  -> clean
6. README "What works" update
7. git add -A && git commit && git push
```

**Build between every step.** Don't do parallel agents on this crate
while WIP is uncommitted (see [Process traps](#process-traps)).

## Tests to add

Selection helpers (pure, fast):

- `selection_caret_is_collapsed`
- `selection_range_min_max_normalises`
- `selection_clamped_caps_both_fields`

`replace_selection_with` (in `mod tests`):

- `replace_collapsed_inserts_at_caret`
- `replace_range_substitutes_and_caret_lands_at_lo_plus_len`
- `replace_at_end_of_string`
- `replace_full_string_with_empty_clears_value`

`byte_offset_at_x` (already exists; add tests):

- `byte_offset_zero_when_x_at_left_edge`
- `byte_offset_at_end_when_x_past_full_width`
- `byte_offset_picks_nearest_boundary`

Mouse-flow integration (use the existing helper pattern from
`layout.rs::tests` — build a tree, compute layout, simulate by calling
the new `App` helpers if practical; otherwise restrict to pure helpers).

Aim for **+15 tests** in this phase to keep the count growing
proportionally with surface area.

## Demo

`examples/input.rs` already exists. Update its `Text` lines to mention
the new shortcuts:

```hypen
Text("Click and drag to select. Cmd/Ctrl+A all, +C copy, +V paste.")
    .fontSize(13)
    .color("gray")
```

Optionally add a second Input bound to a different state field so users
can paste between fields.

## Process traps (lessons from the previous attempt)

1. **Don't run a parallel agent on this crate while Phase 9 WIP is
   uncommitted.** The earlier test-backfill agent saw window.rs in a
   half-converted state (referencing types that didn't exist yet) and
   stashed/reverted my changes to baseline its tests. That cost ~half
   an hour of wall time and a confused user.

2. **Build between every Edit.** Mid-edit broken state is what tripped
   the agent; it would have been fine if `cargo build` was green
   between each Edit call.

3. **Use `Write` for big rewrites of a single file**, not chained
   `Edit`s. Each `Edit` re-checks "modified since read"; on a busy
   tree that fails.

4. **Verify with `git diff` after each change.** If silent reverts
   happen again, you'll catch them in two commands instead of debugging
   for an hour.

## Reference

- Engine `__hypen_bind` contract:
  `hypen-sdk-rs/src/module.rs::handle_bind_action` (line ~1110).
- DSL applicator → prop expansion:
  `hypen-engine-rs/src/ir/expand.rs::process_applicators` (line ~140 for
  `bind`, ~180 for the general dotted-key form).
- Existing keyboard handler to port:
  `hypen-renderer-desktop/src/window.rs::handle_keyboard` and
  `edit_focused_input`. Keep the cross-layout printable-text path
  (`KeyEvent.text`) as-is.
