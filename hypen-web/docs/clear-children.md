# The `clearChildren` patch

`clearChildren` empties one element in a single step. The engine sends it instead of a `remove` per child when a list pass takes away **every** child of the list's element at once — a list cleared (`state.rows = []`), replaced wholesale (no row reused), or a virtualized window that jumps clear of every materialized row. A renderer can then empty the container with one native operation instead of unlinking N siblings one at a time.

```json
{ "type": "clearChildren", "id": "4294967301" }
```

| Field | Meaning |
|---|---|
| `id` | The element to empty. It stays, with all of its own props, semantics and listeners. |

There is no capability negotiation: **every renderer and every remote client must handle it**, like every other patch type. Servers and relays forward it untouched.

## What applying it means

It is exactly equivalent to a plain `remove` (no `transition`) for each of the element's current children, in order:

- Every child is unlinked from `id`.
- Every node in every child's subtree is dead: release its native element, its event listeners, timers and animations, and drop its entry from the renderer's id table. As with a plain `remove`, only the subtree roots are implied — the renderer owns descendant teardown.
- `id` itself is untouched and can receive children again, in the same batch.
- An unknown `id` is ignored, like any patch naming a node the renderer does not have.

## What the engine guarantees

- **It comes first.** When the same batch adds new children under `id` (a wholesale replace), `clearChildren` is positioned before their `create` / `instantiate` / `insert` patches: clear, then fill.
- **Only whole elements.** It is emitted only when everything rendered under `id` belongs to the one list being emptied. A list that shares its parent with other content (`Column { Text("header") ForEach(…) }`) keeps per-row `remove`s.
- **Never for exits.** A row carrying an exit transition (`"__anim.exit"`) is always removed with its own `remove { transition: true }`, so a batch never clears animated rows.
- **Never `"root"`.** `id` is always a real element.
- **At least two children.** A single leaving child is a plain `remove`.
- Reserved props on `id` are independent: a windowed list still gets its `__virt.window` `setProp` in the same batch.

One case needs a decision from the renderer: a child still on screen only because the renderer is playing an exit from an **earlier** `remove { transition: true }` is already dead to the engine. The renderer may cut that exit short or let it finish; both are correct.

## Bindings

| Surface | Shape |
|---|---|
| JSON (wasm-bindgen, WASI, remote protocol) | `{ "type": "clearChildren", "id": "<id>" }` |
| UniFFI (Kotlin, Swift) | `Patch` record with `patchType == PatchType.ClearChildren` (`.clearChildren` in Swift) and `id` set; every other field at its default. The case is appended last in the enum. |

Engine reference: `Patch::ClearChildren` in `hypen-engine-rs/src/reconcile/patch.rs`; emitted by `reconcile_iterable_children_full` in `reconcile/keyed.rs` (`can_clear_children` holds the conditions above); pinned by the `ClearChildren` tests in `hypen-engine-rs/tests/test_lazy_list.rs`.
