# `fixtures/dnd/` — drag-and-drop conformance fixtures

Two kinds of fixture live here (`hypen-web/docs/dnd.md`):

1. **Lowering fixtures** (`*.json` except `path-move.json`) — ordinary
   `test-case.schema.json` fixtures (`input.source` DSL → expected `create` /
   `setProp` patches) pinning the DSL → `__dnd.*` / `__anim.states*` wire that
   every renderer consumes. Category `dnd`; replayed against Rust, TypeScript WASM, and Go WASI
   by the runners in `../../runners/` and by
   the engine crate (`hypen-engine-rs/tests/test_dnd.rs::dnd_fixtures`).
2. **`path-move.json`** — a state-transform fixture for `portable::path_move`
   (§5). It does **not** use the engine-level `test-case.schema.json` shape (no
   DSL input / expected patches) nor the `portable.schema.json` shape (one
   input → one output). It pins a **state transform**: many
   `(state, op) → expected` cases for one function.

## Lowering fixtures

| File | Pins |
|---|---|
| `draggable-lowering.json` | `__dnd.source` spec + bound `__dnd.sourceEnabled` re-resolving as `setProp`; no `draggable.*` junk; `__dnd.key` absent outside a `ForEach` |
| `draggable-malformed-degrade.json` | positional group / unknown activation / non-bool handle → defaults, never an error |
| `drop-zone-lowering.json` | `__dnd.zone` + static `__dnd.zoneId` + bound `__dnd.zoneEnabled` |
| `drop-zone-defaults.json` | out-of-range band → 0.5, group null, optional pieces absent |
| `drop-zone-files.json` | `files: true` adds `"files": true` + `"accept"`; `accept:` alone is ignored |
| `sortable-lowering.json` | `__dnd.sort` + `bind`; `__dnd.key` stamped on the draggable below the row root (not on the wrapper); `payload: @item` resolves; no translate injection; host reorder → no rebuild |
| `sortable-group-from-id.json` | group defaults from a static `.id()` applied after `.sortable()` |
| `pinboard-reserved-lowering.json` | `__dnd.pin` defaults; `__dnd.pinGroup` + injected `translateX.0`/`translateY.0` (number when pinned, explicit `null` when not); reserved-path write → `setProp` only |
| `pinboard-user-field-lowering.json` | `bind` present ⇒ user-field mode: author translates, no `__dnd.pinGroup` |
| `pinboard-reserved-without-group-dropped.json` | reserved mode without a group lowers nothing for the board |
| `states-headerless-runtime.json` | `__anim.states` `{label: null, runtime: true}` + `__anim.statePoses` + synthesized `__anim.transition`; base props untouched |
| `states-headerless-without-dnd-ignored.json` | header-less block without a `__dnd.*` prop is ignored |
| `event-applicators-passthrough.json` | `onSort.0` / `onDragOver.0` / `onDragOver.dwell` flow through the generic path |

## `path-move.json` format

```jsonc
{
  "name": "path-move",              // fixture id (kebab-case)
  "description": "...",
  "function": "path_move",          // which portable function every host must call
  "priority": "P0",
  "cases": [
    {
      "name": "same-array-forward", // case id
      "state": { ... },             // input state (JSON)
      "op": {                       // path_move arguments
        "fromPath": "tasks", "from": 0,
        "toPath":   "tasks", "to":   2
      },
      "expected": { ... },          // resulting state — byte-equal after JSON normalisation
      "moved": true                 // the function's boolean result
    }
  ]
}
```

Semantics under test for `path_move` (`hypen-engine-rs/src/portable/path.rs`):

- Both paths must resolve to arrays and `from` must be in range, else the
  state is **untouched** and `moved` is `false`.
- `to` is the moved item's **final index** in the destination array, clamped to
  `[0, dest.len()]` **after** the removal (`arr.splice(to, 0, arr.splice(from, 1)[0])`).
- Same array, `from == to` → no-op, `moved: true`.
- Destination **inside the source array** (tree DnD, `entries` → `entries.2.children`):
  the removal shifts later siblings down by one, so the destination is
  re-addressed to the same element (`entries.1.children` after removing index 0).
  A destination inside the moved element itself (`entries.0.children` when moving
  index 0) is refused: untouched, `moved: false`.

## Runners

- Rust engine: `hypen-engine-rs/src/portable/path.rs` →
  `move_matches_dnd_conformance_fixture` (runs under `cargo test`).
- Other hosts (TS `app.ts` Proxy mirror, Go `state.go`, Kotlin/Swift via UniFFI
  `portable_path_move`) read this same file and iterate `cases`.

The generic engine-level runners (`runners/{rust,typescript,golang}`) walk
`fixtures/` recursively and must skip **`path-move.json`** (any fixture
carrying a `function` key) — NOT this directory, whose other files are
ordinary `test-case.schema.json` fixtures they should replay.
