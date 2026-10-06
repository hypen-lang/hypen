# Drag & Drop

Hypen does drag-and-drop through four *role* applicators — `.draggable()`, `.dropZone()`, `.sortable()`, `.pinboard()` — one *write* applicator you already know, `.bind()`, and six *event* applicators — `.onDragStart()`, `.onDragOver()`, `.onDrop()`, `.onSort()`, `.onPin()`, `.onDragEnd()`. A role declares what a node *is* in the gesture; the engine ships that declaration to the renderer as reserved `__dnd.*` props, and the renderer runs the whole drag locally — ghost, sibling shifts, zone highlight — without sending per-frame positions to the engine (opted-in start and hover events still dispatch). The drop is one semantic outcome: a reorder (`path_move` on the bound list), a position (two field sets), or a transfer event your module handles. No per-frame drag position enters state, there are no new patch types, and a renderer that doesn't implement the channel simply ignores the props — your UI stays a correct, static list on every platform.

## Setup and Host Support

Use an engine, host SDK, and renderer built with DnD support. Standard DOM, Canvas, SwiftUI, Compose, and desktop renderers attach their coordinator automatically; there is no plugin registration or feature flag. Put a stable `key:` on the `ForEach`, `.draggable()` on the lift surface, and `.sortable().bind(@state.tasks)` on the container. The TypeScript, Go, Kotlin, Swift, and Rust hosts register the outcome handlers automatically. Add `.onSort` only when you need application work such as saving to a server; define that action in the module as usual.

**Ownership and versions:** Use matching engine, host, and renderer builds. Renderers send the originating node with each UI action; the engine resolves its live module and invokes that module's handler. Bind, reorder, pin, and DnD callbacks can safely reuse names and paths across modules. Stale or detached nodes and ambiguous legacy dispatches are rejected. Upgrade all three layers together: older engines do not recognize the new internal dispatch envelope.

Automatic list transfers require both lists to belong to the **same module**. For a cross-module transfer, handle the destination's `.onSort` and mutate both modules through the application context. Its payload includes `fromScope` and `toScope` (lowercase module names; empty string for the primary slot). The automatic write is rejected and the drag preview expires without changing either list.

All five hosts — TypeScript, Go, Kotlin, Swift, and Rust — register automatic reorder/pin handlers. Fractional pins and custom coordinate field names work in reserved and bound modes. No extra module action registration is needed.

## Quick Start

```hypen
// Reorder a list: two applicators, no handler
Column {
    ForEach(items: @state.tasks, key: "id") {
        TaskRow("@{item.title}").draggable()
    }
}
    .sortable(axis: y)
    .bind(@state.tasks)                              // the engine reorders state.tasks for you

// Kanban: sort within a column AND transfer between columns, then tell the server
Column { ForEach(items: @state.todo,  key: "id") { Card("@{item.title}").draggable() } }
    .sortable(group: "board").bind(@state.todo).onSort(@actions.persistBoard)
Column { ForEach(items: @state.doing, key: "id") { Card("@{item.title}").draggable() } }
    .sortable(group: "board").bind(@state.doing).onSort(@actions.persistBoard)

// Drop onto a target: the module owns the mutation
Row { Text("Trash") }
    .dropZone(group: "board", id: "trash")
    .onDrop(@actions.deleteCard)                     // payload: { item, from, to }
    .states { onState(over).backgroundColor("#fee2e2") }   // runtime label, no state path

// Pinboard: drop anywhere, stay there — positions live in reserved module state
Stack {
    ForEach(items: @state.notes, key: "id") {
        StickyNote("@{item.text}").draggable()
            .states { onState(lifted).opacity(0.85).scale(1.04) }
    }
}
    .size(1200, 800)
    .pinboard(group: "board", grid: 8)

// Drop a file ONTO a folder row inside a sortable list (the band rule)
Column {
    ForEach(items: @state.entries, key: "id") {
        Row { Icon("@{item.kind}") Text("@{item.name}") }
            .draggable(group: "fs")
            .dropZone(group: "fs", id: "@{item.id}", enabled: @item.isFolder)
            .onDrop(@actions.moveInto)
    }
}
    .sortable(group: "fs").bind(@state.entries)

// Handles: put .draggable() on the grip — only that subtree lifts, so buttons stay
// buttons and touch scrolls (`handle: true` documents the intent; it changes nothing)
Row {
    Icon("grip").draggable(handle: true)
    Text("@{item.title}")
    Button("Edit").onClick(@actions.edit)
}
```

**Identity is the `ForEach` key.** `.draggable()` takes no id — the engine stamps every draggable in a `ForEach` row with the row's key (`key:` field value, else the item's `id`, else `<itemName>-<index>`), and that key is what every payload's `item` field carries and what the reserved `__dnd` state is keyed by. Outside a `ForEach` the node id stands in.

## `.draggable()` — Lift Surfaces

Marks a node as something the user can pick up. Flat named arguments only (the family rule shared with `.scrub`) — a positional argument (`.draggable("cards")`) warns and is ignored.

```hypen
.draggable()                                     // inherits group and axis from the enclosing .sortable / .pinboard
.draggable(group: "cards")                       // can only land on zones/sortables/pinboards of that group
.draggable(group: "cards", payload: @item)       // extra user data rides in every event payload
.draggable(handle: true)                         // informational: the lift surface is always this node's own subtree
.draggable(activation: press)                    // auto | slop | press | immediate
.draggable(enabled: @state.canEdit)              // bindable; false makes the node inert to drag
```

| Argument | Type | Default | Notes |
|----------|------|---------|-------|
| `group:` | string (static) | `null` | `null` means "ungrouped": inherits the enclosing sortable/pinboard's group, else matches only ungrouped zones and its own container. A binding warns and the default stands. |
| `payload:` | any (bindable) | absent | Resolved value is delivered as `payload` in every event. `payload: @item` passes the whole item. |
| `handle:` | bool (static) | `false` | **Informational in v1 — no renderer reads it.** The lift surface of *any* `.draggable` is its own subtree, so the grip pattern is simply `.draggable()` on the grip node (the enclosing sortable/pinboard child is what moves); `handle: true` records that intent and is carried in `__dnd.source` but never changes behaviour. |
| `activation:` | `auto` \| `slop` \| `press` \| `immediate` | `auto` | See [Activation](#activation). Unknown token warns and falls back to `auto`. |
| `enabled:` | bool (bindable) | `true` | Re-resolves per render; a disabled source never claims the pointer and is skipped by keyboard lift. |

Lowers to `__dnd.source` (`{group, handle, activation}`) plus split bindable pieces `__dnd.sourcePayload` and `__dnd.sourceEnabled`, and inside a `ForEach` row the engine adds `__dnd.key`. Rows whose template carries a draggable are always delivered as plain `Create`/`Insert` (never through the template fast path) so each row carries its own identity.

## `.dropZone()` — Drop Targets

Makes a node a target a compatible drag can be dropped *into*. Put it on a container (a column, a trash can) or on an item inside a sortable list (a folder row — see [the band rule](#the-band-rule)).

```hypen
.dropZone()                                      // ungrouped: accepts ungrouped sources and its own descendants
.dropZone(group: "fs", id: "trash")              // id is what from.zone / to.zone carry
.dropZone(group: "fs", id: "@{item.id}", enabled: @item.isFolder)
.dropZone(group: "fs", band: 0.3)                // narrower "into" band on a sortable item
```

| Argument | Type | Default | Notes |
|----------|------|---------|-------|
| `group:` | string (static) | `null` | Which sources may land here. `null` accepts ungrouped sources (and the zone's own descendants). |
| `id:` | string (bindable, templates allowed) | the node's `id` prop, else the node id | What `to.zone` carries in the payload. `"zone-@{item.id}"` is a template and re-resolves. |
| `enabled:` | bool (bindable) | `true` | A disabled zone is transparent: on a sortable item it has no "into" band and behaves as an ordinary row. |
| `band:` | number 0..1 | `0.5` | The middle fraction of a sortable item, along the sort axis, that means "into". Out of range warns and falls back to `0.5`. |
| `files:` | bool (static) | `false` | Also react to files dragged in from outside the app (the OS, another app). See [Files from the OS](#files-from-the-os). |
| `accept:` | string (static) | `null` (any) | Only with `files: true`. An `<input accept>` filter (`"image/*"`, `"application/pdf"`, `".pdf"`, comma-separated). |

Lowers to `__dnd.zone` (`{group, band}`, plus `"files": true` and `"accept"` when `files: true`) and `__dnd.zoneId` and `__dnd.zoneEnabled` when given. A source is never a zone for itself, and nothing under the lifted item is a target. The innermost enabled, group-compatible zone under the pointer wins.

### Files from the OS

A zone with `files: true` also reacts while files dragged in from outside the app hover it. The files never reach your module: the zone gives instant feedback and a signal, and the app answers the signal with a `file.pick`, whose host dialog takes the actual drop (see the device docs).

```hypen
Column { Text("Drop photos here") }
    .dropZone(files: true, accept: "image/*")
    .onFileDragEnter(@actions.upload)            // → context.device.request("file.pick", …)
    .states { onState(over).backgroundColor("#eef2ff").borderColor("#6366f1") }
```

Renderer contract for a `files: true` zone that is enabled:

1. **`over` pose.** While an OS file drag hovers the zone, apply the same runtime `over` label an in-app drag would, and clear it on leave, drop or cancel. The innermost enabled files zone under the drag that accepts it wins. A zone that rejects the drag (disabled, or `accept` doesn't match) lets the nearest enclosing zone that accepts it light up instead. Only one zone is `over` at a time. The pose is renderer-local: no state, no engine round trip.
2. **`accept`.** When the platform can tell the dragged items' types before the drop, light up only if at least one item matches `accept` (MIME type, `type/*` wildcard, or `.ext` against a known file name). Types the platform can't tell before the drop count as a match. Never read file contents to decide.
3. **`.onFileDragEnter`.** If the zone node carries `.onFileDragEnter`, dispatch it once per entry, under the same condition that lights `over` (zone enabled, drag matches `accept`), so an app never opens a picker for the wrong types. `.onFileDragEnter` on a node that is not a files zone is inert on every renderer (no dispatch, no swallowed drop). Dispatch it (nested children don't re-fire) with `{type: "filedragenter", timestamp, items}`, where `items` is how many items the drag holds (`0` when unknown). Custom named arguments replace that payload, as for other events. Never include names, paths or bytes.
4. **The release.** Files released on the zone are not delivered and never open or navigate. Show a "no drop" or neutral cursor where the platform lets you choose.
5. **In-app drags are unchanged.** `files:` adds OS-file behavior; `group:`, `band:` and the in-app `over` behavior stay as they are.

A renderer that can't see OS file drags ignores `files:`, and the zone stays an ordinary in-app zone.

## `.sortable()` — Reorderable Lists

Declares a container whose `ForEach` children can be reordered by dragging. Siblings shift to open the gap while the drag is live; on drop the engine reorders the bound list and the renderer's preview reconciles to the real `Move` patches with no flash.

```hypen
Column { ForEach(items: @state.tasks, key: "id") { TaskRow("@{item.title}").draggable() } }
    .sortable()                                  // group from the node's static id (else self-only), axis y
    .sortable(axis: x)                           // a horizontal strip
    .sortable(group: "board")                    // accepts drops from sibling lists of the same group
    .bind(@state.tasks)                          // the write target — omit it to own the mutation yourself
```

| Argument | Type | Default | Notes |
|----------|------|---------|-------|
| `group:` | string (static) | the node's **static** `id` (the `id` argument or `.id("…")`, any chain position), else `null` | `null` = self-only: the list accepts only its own children. A bound id does not default the group. |
| `axis:` | `x` \| `y` | `y` | The sort axis. Also drives the touch activation rule (cross-axis slop). |

Lowers to `__dnd.sort` (`{group, axis}`); the write target is the node's ordinary `bind` prop. A bare `.draggable()` inside the sortable inherits its group. On the DOM renderer the element that moves is the sortable's *direct child* containing the source — `ForEach { Row { Text().draggable() } }` moves the whole `Row` as one — so a draggable handle deep inside a row moves the row.

## `.pinboard()` — Free Placement

Declares a `Stack` whose `ForEach` children can be dropped anywhere and stay where they were dropped. Pixel positions use ordinary `translateX`/`translateY` transforms. Fractional positions use a separate renderer translation, projected against the nearest board’s current content-box width and height. Resizing updates the visual position and hit target without writing state.

```hypen
// Reserved-state mode: positions live in module state under __dnd.<group>.<key>
Stack { ForEach(items: @state.notes, key: "id") { StickyNote("@{item.text}").draggable() } }
    .size(1200, 800)
    .pinboard(group: "board", grid: 8)

// User-field mode: positions ARE your data — bind into your own fields
Stack { ForEach(items: @state.seats, key: "id") {
    Seat("@{item.label}").translateX(@item.x).translateY(@item.y).draggable()
} }
    .pinboard(x: "x", y: "y")
    .bind(@state.seats)
    .onPin(@actions.seatMoved)
```

| Argument | Type | Default | Notes |
|----------|------|---------|-------|
| `group:` | string (static) | the node's static `id`, else `null` | **Required in reserved-state mode** (it is the persistence key). Missing ⇒ the board warns once and lowers nothing (the `.draggable`s still lower; the items just don't pin). |
| `x:` / `y:` | field names (static) | `"x"` / `"y"` | The item fields written in user-field mode, and the leaf keys under `__dnd.<group>.<key>` in reserved mode. |
| `grid:` | number | none | Snap increment in the board's units. `grid <= 0` warns and disables snapping. |
| `bounds:` | `clamp` \| `free` | `clamp` | `clamp` keeps the item inside the board's content box. |
| `units:` | `px` \| `fraction` | `px` | `fraction` stores normalized coordinates and projects them against the current content box when drawing and hit-testing. Resize never writes coordinates back to state. |

**Mode is decided by the node's `bind` prop after all applicators:**

- **No `.bind` ⇒ reserved-state mode.** Position is presentation state, not domain state — your `Note` type grows no screen coordinates. The engine propagates `__dnd.pinGroup` onto every draggable under the board and *injects* `translateX`/`translateY` bindings to `__dnd.<group>.<key>.x/.y` on each item (unless you set a translate yourself). An item with no stored position resolves those to `null`, which every renderer treats as `0`. A drop writes `__hypen_pin { path: "__dnd.<group>.<key>", x, y }` and exactly that node re-renders with two `SetProp`s — no row rebuild.
- **`.bind(@state.list)` ⇒ user-field mode.** With `units: px`, write `.translateX(@item.x).translateY(@item.y)` yourself. With `units: fraction`, omit these translates: the engine supplies normalized positions using `x:` and `y:`; a drop writes `<bindPath>.<index>.<xKey>` and `.<yKey>`. Use this when coordinates are the product (a floor plan, a seating chart) — and read the [typed-host contract](#the-reserved-__dnd-state-and-typed-hosts) first.

Coordinates: `(x, y)` = the item's top-left minus the board's **content-box** origin (inside padding), in logical units, after grid snap, clamp, and the `units:` conversion. Lowers to `__dnd.pin` (`{group, xKey, yKey, grid, bounds, units}`).

### Fractional coordinates and custom fields

```hypen
Stack { ForEach(items: @state.notes, key: "id") {
    StickyNote("@{item.text}").draggable()
} }
    .pinboard(group: "board", x: "left", y: "top", units: fraction)
```

This stores `state.__dnd.board.<key>.left` and `.top`. A value of `0.5` means half the board's content width/height, including after resize. Add `.bind(@state.notes)` to store those fields on each note instead. In fraction mode, omit authored pixel translates unless you intend to override an axis. Coordinate fields must be nonempty leaf names (no dots); `__proto__`, `prototype`, and `constructor` are not allowed.

## `.bind()` — The Write

`.bind(@state.path)` on a `.sortable` or `.pinboard` names the state the drop mutates, and the SDK applies that mutation for you *before* any event fires. It is the same applicator inputs use, with the same meaning — "this node writes to that path" — and the same rule: `.bind` and the matching `on*` event work independently and both fire.

| Role | Reserved action the renderer dispatches | What the host does |
|------|------------------------------------------|--------------------|
| `.sortable().bind(@state.tasks)` | `__hypen_reorder { path, from, to }` (same list) or `{ fromPath, from, toPath, to }` (between two bound lists of one group) | `portable::path_move`: splice the item out of the source array and into the destination at `to` — the item's **final** index, clamped to `[0, len]` after removal. Same-array `from == to` is a no-op. A destination inside the moved element is refused. |
| `.pinboard(...)` (either mode) | `__hypen_pin { path, x, y, xKey, yKey }` | Two path sets, `path.xKey` and `path.yKey`, batched into one flush; missing intermediates auto-vivify (the first pin of a note creates `__dnd.board.n1`). |

Both writes go through the module's **tracked state** (the TypeScript Proxy; Kotlin/Swift/Go `ObservableState`; Rust typed state with a reserved-state sidecar) — never engine state directly — so they invalidate dependents, persist with `.persist(...)`, stream under Remote UI, and survive the Router cache exactly like a mutation your own handler made. There is no DnD-specific storage anywhere: the order *is* `state.tasks`; the pins *are* `state.__dnd.board`.

Rules of the write:

- **An unbound sortable does not write.** Its `.onSort` handler owns the mutation. An unbound pinboard automatically writes reserved `__dnd` positions; omitting `.bind` does not disable its writes.
- **A drop back on the origin slot writes nothing** and fires only `.onDragEnd { dropped: true }`.
- **A transfer between a bound and an unbound sortable writes nothing** (warns once) but still fires `.onSort` on the destination — the module decides.
- **Transfers into a `.dropZone` never write.** A zone is an event target; the module moves the data (`.onDrop`).
- Malformed or out-of-range reserved payloads warn and no-op on every host.

## Events — `.onDragStart()` … `.onDragEnd()`

Six ordinary event applicators — same dispatch channel as `onClick`, no new syntax, zero cost on nodes that don't declare them. All but two fire only at the drop; `.onDragStart` and `.onDragOver` are the opt-in mid-drag escalations.

```hypen
.onDragStart(@actions.dragBegan)                 // on the draggable, or on the sortable/pinboard to cover all children
.onDragOver(@actions.openFolder, dwell: 600)     // on a zone: pointer rests over it for dwell ms — once per entry
.onDrop(@actions.moveInto)                       // on a zone: the drop resolved INTO it
.onSort(@actions.persistBoard)                   // on a sortable: the drop resolved as a reorder (fires on the DESTINATION list)
.onPin(@actions.seatMoved)                       // on a pinboard: the drop resolved as a position
.onDragEnd(@actions.dragEnded)                   // drop AND cancel: { …, dropped: true | false }
```

| Event | On | Fires when | Engine writes first? |
|-------|----|-----------|----------------------|
| `.onDragStart` | draggable, else its enclosing sortable/pinboard | the pointer is claimed (after activation) | — |
| `.onDragOver(dwell:)` | dropZone | the pointer has rested over the zone for `dwell` ms (default **500**), once per entry, coalesced | — |
| `.onDrop` | dropZone | the drop resolved *into* this zone | — |
| `.onSort` | sortable (destination) | the drop resolved as a reorder or a cross-list transfer | `.bind` → `__hypen_reorder`, if a write target exists |
| `.onPin` | pinboard | the drop resolved as a position on the same board | `__hypen_pin` (reserved or bound fields) |
| `.onDragEnd` | draggable, else its enclosing sortable/pinboard | drop **or** cancel | — |

**Ordering on drop:** (1) the reserved write, if any; (2) `.onSort` / `.onPin` / `.onDrop`; (3) `.onDragEnd { dropped: true }`. **Cancel** (Esc, a drop outside every compatible target, focus loss, or the item being removed mid-drag): only `.onDragEnd { dropped: false }` — and a node removed or detached mid-drag dispatches *nothing*.

`dwell:` is a reserved named argument on `.onDragOver` (like `animate:` on click handlers): renderers read it and strip it from the payload. Any other extra named arguments merge *under* the payload — the payload's own fields always win — and `animate:` stamps the dispatch like a click does on TypeScript hosts.

### The payload

Every `.on*` event receives the same object, so one handler can serve many zones:

```ts
{
  item: string,                            // the ForEach key of the dragged node (node id outside a ForEach)
  payload?: unknown,                       // .draggable(payload:) — extra user data, resolved
  from: { zone: string, index: number | null },
  to:   { zone: string, index: number | null },   // index null = "into", not "at"
  x?: number, y?: number,                  // .onPin only — board content-box units, after grid/units
  dropped?: boolean,                       // .onDragEnd only
}
```

`zone` for a sortable or pinboard is its `group` if set, else its resolved `id` prop, else the node id; for a `.dropZone` it is the zone's `id:`. For a draggable outside any sortable or pinboard (a loose source), `from.zone` is the nearest enclosing `.dropZone` label, else the parent node id, and `from.index` is `null`. `index` for a sortable is the position among the list's draggable children. For a pin, `to = { zone, index: <origin index> }` (same board); a *foreign* compatible pinboard is a plain "into" zone (`.onDrop`), never a pin write.

```typescript
export default app
  .defineState<{ todo: Card[]; doing: Card[] }>({ todo: [], doing: [] })
  .onAction("moveCard", async ({ action, state }) => {
    const { item, from, to } = action.payload;       // from: {zone: "todo", index: 3}  to: {zone: "doing", index: null}
    const card = state[from.zone].splice(from.index, 1)[0];
    state[to.zone].push(card);
  })
  .onAction("persistBoard", async ({ state }) => {
    // .bind already applied the move — state is the new truth. Just sync it.
    await api.saveBoard({ todo: state.todo.map((c) => c.id), doing: state.doing.map((c) => c.id) });
  });
```

## `.states { }` — Runtime Labels `lifted` and `over`

A `.states` block **without a state path** on a node that carries any DnD role is driven by the renderer, not by state: **`lifted`** applies to the dragged source while it is in the air, **`over`** to a zone while a compatible drag hovers it. They are `.states` poses, so they are cross-renderer looks rather than CSS — the same pose machinery, exclusions (no bindings, no `.bind`, no event or animation applicators, and no role applicators inside a pose), and synthesized timing as a state-driven block.

```hypen
Card("@{item.title}")
    .draggable()
    .states {
        onState(lifted).opacity(0.6).scale(1.04).tw("shadow-xl")
    }

Column { ... }
    .dropZone(group: "cards", id: "doing")
    .states(transition: easeOut, duration: 120) {
        onState(over).backgroundColor("#eef2ff").borderColor("#6366f1")
    }
```

- The header-less form is accepted only when the node ends up with a `__dnd.*` prop after every applicator has lowered — `.draggable().states { … }` and `.states { … }.draggable()` both work; a header-less block on a node with no role fires the usual "missing state reference" warning and is ignored. A reserved-mode `.pinboard` that was dropped for lack of a group does *not* qualify.
- The engine ships the node's own props untouched as the base, `__anim.states = {"label": null, "runtime": true}` (never a `SetProp`), and `__anim.statePoses = { "lifted": { "opacity.0": 0.6, … }, "over": { … } }` keyed by lowered prop keys. Renderers overlay `statePoses[label]` through the ordinary per-prop path and restore the base when the label clears; two labels never apply at once. Variant-qualified pose keys (`padding@md.0`, `backgroundColor:hover.0`) are **not portable**: the DOM, desktop and iOS renderers skip them with a one-time warning, while Canvas and Android overlay them like any other key (through their ordinary prop/variant path, no warning) — so a pose that depends on one looks different per renderer. Keep runtime poses to unqualified keys.
- A `.states(@state.x) { … }` with a header on a DnD node behaves exactly as before — state-driven, no runtime labels.
- Timing: the synthesized transition (defaults `easeOut`, 250ms, scoped to the overridden animatable props) glides the label switch on the DOM and iOS renderers and through the Canvas renderer's setProp path (its `.transition` matrix applies); desktop and Android snap the pose switch. Under reduced motion the pose still applies — it snaps.

## The Reserved `__dnd` State and Typed Hosts

Reserved-mode pinboards keep positions in a runtime-owned subtree of the **module's own state map**, keyed by group then item key:

```jsonc
{
  "notes": [ { "id": "n1", "text": "…" }, { "id": "n2", "text": "…" } ],
  "__dnd": {
    "board": {                         // .pinboard(group: "board")
      "n1": { "x": 296, "y": 200 },    // keyed by the ForEach key; leaf keys are the x:/y: names
      "n2": { "x": 40,  "y": 512 }
    }
  }
}
```

It is ordinary state: it persists with `.persist(...)` and is restored before `onCreated`, streams under Remote UI, survives the Router cache, and round-trips through snapshot/restore. Your handlers can read it untyped (`state.__dnd.board.n1`). An item that leaves the list leaves its entry behind (a re-added note comes back where it was); prune it yourself if a board churns ids. Seeding it in `defineState` (`__dnd: { board: { n1: { x: 40, y: 60 } } }`) is legal and gives initial positions.

**Typed hosts (Kotlin, Swift).** Typed state is a *view* over the map, and the decode ignores unknown keys — which is exactly how a pin written to a field the data class does not declare would be silently wiped by the next `syncBack`. The contract that closes that:

- **MUST — reserved keys survive.** `syncBack` merges the typed encoding *over* the map and never replaces it wholesale; top-level keys prefixed `__` (`__dnd`) are preserved untouched. This is what makes the default reserved-state pinboard safe on every host with no schema obligation: the user's `Note` never carries `x`/`y`. Implemented in Kotlin (`Dsl.kt`), Swift server (`TypedBuilder.swift`), and Rust (`StateContainer` plus Remote UI JSON state). Rust supports `#[serde(deny_unknown_fields)]` without requiring `__dnd` in the application struct; unrepresentable bound coordinate writes are rejected atomically.
- **SHOULD — dropped user keys warn.** For the `.bind` (user-field) form, `syncBack` compares key sets and warns once per path when the typed encoding drops a key the map had (`TypedHypenModuleBuilder.warnOnDroppedKeys`, default on, in Kotlin; `TypedStateSyncConfig.warnOnDroppedKeys` in Swift). The fix is one of: add `var x: Double` to the item type, drop `.bind` for the reserved form, or use `.onPin` and apply the write in your handler.
- **Sort is immune** — `__hypen_reorder` moves existing elements and adds no keys. **Transfer is immune** — the module's own typed handler does the mutation. On immutable-model hosts prefer `.onPin` + `copy(x = …, y = …)` over `.bind`; both forms produce the same wire event.
- **Go** has only the untyped map SDK: `ObservableState.Move` and `Set` are the whole story.

**Module ownership:** reserved pins belong to the draggable’s module; bound pins and reorders belong to the bound container’s module. Event handlers run in the module that owns the node declaring the event. Equal group names do not grant access to another module’s state.

## Activation

A drag that begins on pointer-down steals scrolling — on touch that is the feature being unusable. `auto` therefore picks the rule per input:

| Input | `auto` resolves to | Rationale |
|-------|--------------------|-----------|
| Mouse / pen / trackpad | `slop` — 6px of travel along any axis | matches `.scrub`; a tap is a total no-op and child clicks pass through |
| Touch, inside an axis-constrained `.sortable` | slop on the **cross** axis (sideways travel lifts; travel along the list scrolls it) | scroll and drag coexist without a delay |
| Touch, anywhere else (pinboards, loose draggables) | `press` — a ~300ms long-press; travel before it fires is a scroll | the platform idiom on both iOS and Android |
| Any input, `.draggable()` on a grip node | the same rules, on the grip's subtree only (the enclosing row moves) | the grip removes the ambiguity — **prefer this on mobile** |

The lift surface is always the `.draggable` node's own subtree; `handle: true` does not restrict or extend it on any renderer (see the argument table). Override per source with `.draggable(activation: slop | press | immediate)`. Below the threshold a release is a **total no-op** — no pointer capture, no styles, no events, and the node's own `.onClick` still fires. Once claimed, only the claiming pointer's move/up/cancel events drive the drag (a second finger is noise), and pointer capture is taken on the DOM renderer.

## The Band Rule

An item in a `.sortable` that is *also* a `.dropZone` (a folder row) participates in two disciplines, and the renderer arbitrates with the Finder / VS Code convention — the item's box is split along the sort axis:

```
        ┌──────────────────────────┐
  25%   │   insert BEFORE          │  ← .sortable claims: reorder
        ├──────────────────────────┤
  50%   │   drop INTO              │  ← .dropZone claims: .onDrop   (band: 0.5)
        ├──────────────────────────┤
  25%   │   insert AFTER           │  ← .sortable claims: reorder
        └──────────────────────────┘
```

The middle `band` fraction means *into*; the outer `(1 - band) / 2` on either side fall through to the sortable's before/after slot. Bands are half-open (a pointer exactly at a band's start belongs to it); `band: 0` never yields "into", `band: 1` yields "into" anywhere inside the item. A zone with `enabled: false` has no inner band and behaves as an ordinary sortable row. The renderer never rejects a semantically invalid drop (a folder into its own descendant) — only the module knows the tree, so check it in `.onDrop`.

## Group Compatibility

- A source's **effective group** is its own `group:` if set, else its enclosing sortable's/pinboard's group.
- A **sortable or pinboard** always accepts its own children; with a group it also accepts foreign sources of that group (cross-list transfer). Self-only (`group: null`) lists accept nothing from outside.
- A **`.dropZone`** with a group accepts sources of that group; an ungrouped zone accepts ungrouped sources and its own descendants.
- The innermost enabled, compatible target under the pointer wins; the source and everything under the lifted item are excluded.

## Keyboard Operation

Every pointer drag is also keyboard-operable with no extra markup, and it emits the **identical** actions and events, so handlers never learn which input device fired them. The state machine (`KeyboardDragMachine`) lives in `@hypen-space/core` so every renderer can share it.

| Key | Effect |
|-----|--------|
| `Tab` | focus a draggable (it joins the tab order automatically; `aria-grabbed="false"`) |
| `Space` | lift (`aria-grabbed="true"`, announces "t3, position 3 of 5") |
| `↑ ↓ ← →` | move to the previous / next slot within the sortable (live preview, announces the new position) |
| `Tab` / `Shift+Tab` | move to the next / previous compatible zone (wraps; announces "t3, over trash") |
| `Space` | drop — the same commit path as a pointer drop: reserved write → `.onSort`/`.onDrop` → `.onDragEnd { dropped: true }` (announces "t3, dropped"); dropping on the origin slot writes nothing |
| `Esc` (or focus leaving the item) | cancel — `.onDragEnd { dropped: false }` only (announces "t3, cancelled") |

On the DOM renderer, announcements go through one shared polite live region per document; the Canvas renderer runs the same machine and mirrors `aria-grabbed` but does not announce in v1 (its `describeKeyboard()` returns the sentence for a host to voice). Keyboard drag covers sortables and drop zones; **pinboard items cannot be lifted from the keyboard** in v1 (a Space on one warns).

Keyboard narrowings (DOM and Canvas):

- **Zone counts are snapshotted at lift.** A row inserted or removed by the engine mid-drag (a spring-loaded folder) rebuilds the pointer slots, but the keyboard machine's per-zone counts are not refreshed — a keyboard drop after such a re-render may carry an index the host clamps.
- **No visual preview inside a foreign list.** `Tab` to another sortable opens that list's gap, but the lifted item itself stays at its origin (ghost at `translate(0, 0)`); only moves within the origin list slide the item.
- **Foreign-zone naming.** `KeyboardDragMachine.describe()` names a foreign zone by its **node id** (`"t3, c1, position 2 of 2"`). The DOM substitutes the §4.2 label (group → resolved `id` → node id) in its own live region; a host voicing Canvas `describeKeyboard()` gets the node id and must map it itself. Android exposes the same commit path as TalkBack custom actions ("Move up" / "Move down", or left/right) instead of a keyboard machine; desktop and iOS have no keyboard path in v1 (see the matrix).

## Precedence and Mid-Drag Rules

**Precedence: `dnd > scrub > structural playbacks > transaction > .transition`.** A node owned by a live drag is left out of every other motion system, and:

- Engine writes to the dragged item/source are **deferred** until release, then applied: on the DOM renderer every transform-kind `SetProp` *and* `RemoveProp` (`translateX/Y/Z`, `rotate*`, `scale*`, `skew*`, raw `transform`) is held, as is any write to a pose-overridden key of a node carrying a runtime label; only a `translateX`/`translateY` `SetProp` landing during the post-drop hold releases the hold (it is the engine's re-render). The other renderers defer the translate `SetProp`s (desktop, iOS and Android do not defer a `RemoveProp` of a translate key — the injected binding never emits one). Transform writes to *shifted siblings* are **not** deferred on any renderer: they land in the sibling's saved base and show once the preview releases. Live data on every other prop flows normally.
- **Hold-then-release.** After the drop dispatches, the renderer holds its local transforms until the engine's re-render lands — a `Move`/insert under the origin or destination list, a `Remove` of the item, or (pinboards) the translate `SetProp` on the dragged node — or 500ms, whichever first. No flash; a `.layout()` FLIP sees the ghost's on-screen rect as its starting point, so the item settles into its slot.
- **Structural patches mid-drag are survivable.** Rows inserted while dragging (a spring-loaded folder opening on `.onDragOver`) become live targets immediately: an engine insert/remove under *any* cached sortable (the origin included) rebuilds that list's slots from its live children. After such a rebuild the reserved write's `from` is the dragged item's **live** index while the event payload's `from` keeps the **lift** location, so `action.payload.from.index` and the `__hypen_reorder.from` a handler observes can legitimately differ. A pure layout change without a structural patch (a resize) is not re-measured until the next drag. A `Remove` or route `Detach` of the lifted item or its container cancels cleanly with no dispatch.
- **`enabled: false` mid-drag cancels silently.** A `__dnd.sourceEnabled` `SetProp` flipping to `false` while the item is in the air cancels the drag the same way a `Remove` does — no `.onDragEnd`, no reserved write.
- **No new drag during the hold window.** A `pointerdown` that arrives while the post-drop hold is still open (until the `Move`/translate lands or 500ms) is ignored outright — no pending drag, no events — so a fast double-grab cannot lift a row whose slot is still settling.
- **DOM lift styling:** `touch-action: none`, `user-select: none`, `cursor: grabbing`, `will-change: transform` are set on the source at lift and the prior inline values restored on release or cancel (the source's own `touch-action` is additionally written at arm time — see the DOM matrix — because a touch-time write cannot stop a pan the browser already latched). Transform applicators compose in place — a re-resolved `translateX.0` replaces its own term instead of accumulating, and a `null` translate renders as `0`.
- The existing `.bind` input handler returns early on a node carrying `__dnd.sort` or `__dnd.pin`, so `.bind` on a list never tries to read a form value.

## Reduced Motion

Dragging is direct manipulation — the user's own hand — so it works unchanged under `prefers-reduced-motion: reduce`. The decorative parts snap: the 150ms sibling gap-opening shift and the `lifted`/`over` pose transitions apply instantly. Nothing about the outcome changes.

## Requirements and Degradation

Validation mirrors the animation family: malformed input **warns once and falls back**, never a hard error, and nothing DnD-related ever leaks to the wire as a generic `draggable.*`/`dropZone.*` prop.

| Input | Result |
|-------|--------|
| Positional argument on any role applicator (`.draggable("cards")`) | warns, ignored (arguments are named-only) |
| Binding in a static-only argument (`group:`, `x:`, `y:`, `activation:`, `axis:`, `bounds:`, `units:`) | warns, default stands |
| Unknown `activation:` / `axis:` / `bounds:` / `units:` token, non-boolean `handle:` | warns, default (`auto` / `y` / `clamp` / `px` / `false`) |
| `band:` outside `0..=1`, `grid: <= 0` | warns, `0.5` / no snapping |
| Static `id:` / `enabled:` / `payload:` of the wrong JSON type | warns, prop absent (renderer default: node id / enabled / no payload) |
| Reserved-mode `.pinboard` with no group (no `group:` and no static `id`) | warns once, the board lowers nothing; its `.draggable`s still lower |
| Header-less `.states` on a node with no DnD role | "missing state reference" warning, block ignored |
| `onState(...).dropZone(...)` (a role applicator inside a pose) | warns, that pose prop dropped |
| Malformed `__hypen_reorder` / `__hypen_pin` payload, non-array target, out-of-range index | host warns and no-ops; the renderer's held preview releases on the 500ms fallback and the list snaps back |
| A renderer that doesn't implement the channel | ignores every `__dnd.*` prop: a static, correct list |

## The Wire (for renderer and host authors)

The engine lowers roles into reserved props (`hypen-engine-rs/src/ir/dnd.rs`; renderers route on `startsWith("__dnd.")`). Static props carry one JSON object; bindable pieces are split into their own prop so they re-resolve as `SetProp`. No new `Patch` variants.

| Prop | Value | From |
|------|-------|------|
| `__dnd.source` | static `{"group": string\|null, "handle": bool, "activation": "auto"\|"slop"\|"press"\|"immediate"}` | `.draggable` |
| `__dnd.sourcePayload` / `__dnd.sourceEnabled` | bindable any / bool (absent ⇒ true) | `.draggable(payload:, enabled:)` |
| `__dnd.key` | static string — the `ForEach` item key, stamped on every element with `__dnd.source` in the row (even nested below the row root); absent outside a `ForEach` ⇒ node id | `ForEach` expansion |
| `__dnd.zone` | static `{"group": string\|null, "band": number}` | `.dropZone` |
| `__dnd.zoneId` / `__dnd.zoneEnabled` | bindable string / bool (absent ⇒ resolved `id` prop else node id / true) | `.dropZone(id:, enabled:)` |
| `__dnd.sort` | static `{"group": string\|null, "axis": "x"\|"y"}`; write target = the node's `bind` prop | `.sortable` |
| `__dnd.pin` | static `{"group", "xKey", "yKey", "grid": number\|null, "bounds", "units"}`; `bind` present ⇒ user-field mode | `.pinboard` |
| `__dnd.pinGroup` | static string on every draggable under a reserved-mode board | propagation |
| `translateX.0` / `translateY.0` | injected bindings to `__dnd.<group>.<key>.<xKey>/<yKey>` on pixel reserved-mode items — a number, or `null` when unset (**treat `null` as 0**) | item expansion |
| `__dnd.pinX` / `__dnd.pinY` | normalized positions, or `null` (zero); project against the nearest board content box for paint and hit-testing | fractional item expansion |
| `__dnd.pinItem` / `__dnd.pinGeneratedX` / `__dnd.pinGeneratedY` | engine metadata for the nearest board and generated axes; renderers can ignore | propagation / item expansion |
| `__anim.states` / `__anim.statePoses` / `__anim.transition` | `{"label": null, "runtime": true}` / `{label: {loweredKey: value}}` / synthesized timing | header-less `.states` |
| `onSort.0`, `onDragOver.0`, `onDragOver.dwell`, … | ordinary event props (`"@name"` action refs + named args) | the six event applicators |

Renderers dispatch the internal `__hypen_dispatch` envelope `{node, action, payload, fromNode?}`. `node` is the action owner; reorder also carries the source container as `fromNode`. Ownership comes from the live tree, never a module name in the payload. The engine resolves it to `__hypen_scoped:<scope>:<action>` (empty scope means primary), which hosts register per module. Remote fan-out resolves once in the source session and forwards the scoped semantic action, because node IDs are session-local. The semantic outcomes are `__hypen_reorder { fromPath, from, toPath, to }` (or `{ path, from, to }`) and `__hypen_pin { path, x, y, xKey, yKey }`; hosts apply them through tracked state with `path_move` semantics (Rust `hypen_engine::path_move`; UniFFI `portable_path_move`; wasm `pathMove`; WASI `hypen_portable_path_move`; all return `{"json", "moved"}`). Every shape above is pinned byte-for-byte by the replayable fixtures in `engine-compatibility-tests/fixtures/dnd/` (lowering fixtures plus `path-move.json` with 17 `path_move` cases every host mirrors), and the TypeScript constants, parsers, `resolveBand`, `snapToGrid`, `applyPathMove`, and `KeyboardDragMachine` live in `@hypen-space/core/dnd`.

## Renderer Support

The channel degrades by design: a renderer that doesn't run the drag ignores the `__dnd.*` props and shows a static, correct list; writes and events are host-side; automatic writes require a supported host and the restrictions in Setup and Host Support apply.

| Renderer | `.draggable` activation | `.sortable` preview + hold | `.dropZone` + band | `.pinboard` | `lifted` / `over` poses | Keyboard | Behavior |
|----------|------------------------|-----------------------------|--------------------|-------------|-------------------------|----------|----------|
| DOM (web) | Yes — mouse slop, touch cross-axis slop / 300ms press, pointer capture (`handle:` informational, as everywhere) | Yes — transform shifts (150ms), hold until `Move`/500ms | Yes | Yes — both modes | Yes — glide on the synthesized transition | Yes — Space/Arrows/Tab/Esc, `aria-grabbed`, live region (not on pinboard items) | Pointer/keyboard support |
| Canvas 2D | Mouse only — `auto` is 6px slop, `press`/`immediate` honored; no touch rules | Yes — per-node offsets, ghost painted last, hold until `Move`/500ms | Yes | Yes — both modes | Yes — via the renderer's setProp path | Yes — via the focus manager, `aria-grabbed` mirrored, no live region (not on pinboard items) | Near-full — see the Canvas matrix below |
| Desktop (Vello) | Mouse only (single OS cursor; no winit touch) | Yes — renderer-private offsets fold into layout, paint, hit-test and AccessKit; shifts snap | Yes | Yes — both modes | Yes — snap (no transition for the runtime label) | No — Esc cancels a pointer drag; nothing lifts from the keyboard | Pointer parity — see the desktop matrix below |
| iOS (SwiftUI) | Yes — `DragGesture`/`LongPressGesture` per activation; pointer type is platform-derived (non-macOS = touch) | Yes — `.offset` shifts (150ms ease-out), hold until `Move`/500ms | Yes | Yes — both modes | Yes — glide on the synthesized transition | No — VoiceOver users use the author's controls | Pointer parity, narrowings below — compiled and unit-tested on a Mac; iOS Simulator build passed |
| Android (Compose) | Yes — `awaitEachGesture` per activation plan (6dp slop / cross-axis slop / 300ms press with haptic / immediate) | Yes — `graphicsLayer` offsets (150ms shift), hold until `Move`/500ms | Yes | Yes — both modes (pin coordinates in dp) | Yes — snap (pose-override layer; no transition for the runtime label) | TalkBack custom actions "Move up/down" (no keyboard machine, no live region) | Pointer parity, narrowings below — compiled and unit-tested on a Mac; iOS Simulator build passed |

"Yes" for `.pinboard` means both reserved-state and user-field modes, `grid`/`bounds`/`units` included, and `null` translates rendered as `0`. Every renderer: a tap below the activation threshold is a total no-op; a `Remove`/`Detach` mid-drag cancels with no dispatch; extra named args merge under the payload.

### DOM capability matrix

The reference implementation (`hypen-web/packages/web/src/dom/dnd.ts`), the twin of the scrub runtime. Zone hit-testing is done against layout rects, never `elementFromPoint` (the ghost is under the pointer).

| Channel | DOM behavior |
|---------|--------------|
| Ghost | The source itself (loose draggables, pinboards) or the sortable's direct child containing it, translated with a `translate()` *prepended* to its inline transform (a pinned `translateX(40px)` or a `lifted` `scale(1.04)` survives), raised with `z-index`, plus the §6.7 lift CSS. Prior inline values restored on release. |
| Pointer types | Mouse/pen: any-axis 6px slop. Touch: cross-axis 6px slop inside an axis-constrained sortable (main-axis travel abandons the drag to the scroll), 300ms press elsewhere. Only the claiming `pointerId` drives the drag; `pointercancel` cancels. Because browsers latch `touch-action` when the touch starts, the source's inline `touch-action` is written when it is **armed** (not at lift): `pan-y`/`pan-x` (the sort axis) for `auto` inside an axis-constrained sortable, `none` for `auto` elsewhere and for `press`/`slop`/`immediate` — so a pinboard note or loose draggable does not scroll the page by touch. The prior inline value is restored when the source is disarmed. `contextmenu` is suppressed while a press timer or drag is live. |
| Trailing click | The `click` the browser dispatches after the `pointerup` that ends a **claimed** drag is swallowed (capture-phase guard on the source), so `.onClick` on the draggable or a child never fires on a drop; a below-threshold tap keeps its click. |
| Disabled source | `.draggable(enabled: false)` fully disarms: no listeners, no runtime `tabindex`, no `aria-grabbed`. |
| Lift surface | The `.draggable` element's own subtree (`pointerdown` is attached to the source only); `handle:` is not read. |
| Sibling shift | `transform 150ms ease-out` while dragging (snaps under reduced motion). Rects are measured at lift (before any shift) and **rebuilt from the live children** (once per patch batch, after the batch's DOM writes) whenever an engine insert/remove lands under a cached sortable — origin included, so the reserved write's `from` follows the item's live index (the event payload keeps the lift location); a pure resize with no structural patch is not re-measured until the next drag. |
| Deferral | Every transform-kind `SetProp`/`RemoveProp` on the dragged item/source, and writes to pose-overridden keys of a labelled node, are held until release; only a `translateX`/`translateY` `SetProp` releases a hold. Transform writes to shifted siblings are not deferred (they compose into the sibling's saved base and show after release). |
| Poses | `lifted`/`over` overlaid through the per-prop applicator path with the synthesized `__anim.transition`; variant-qualified keys skipped with a one-time warning. |
| `animate:` | Stamps the drop dispatch like a click. |
| Keyboard | Full §6.8 path; keyboard drag of pinboard items warns and does nothing. Zone counts are captured at lift (not refreshed by a mid-drag rebuild); a foreign list opens its gap but the item is not previewed inside it; the live region names foreign zones by their §4.2 label. |
| Not in v1 | Autoscroll near a scroll-container edge; multi-select; nested sortables. |

### Canvas 2D capability matrix

`hypen-web/packages/web/src/canvas/dnd.ts`. The canvas owns the scene graph, so the drag is geometry on the `VirtualNode` tree; the hit-test now accounts for `translateX`/`translateY` (a prerequisite fix that also corrects static transforms).

| Channel | Canvas behavior |
|---------|-----------------|
| Input | **Mouse events only** — the touch-specific `auto` rules (cross-axis slop, press) never apply; `auto`/`slop` = 6px any-axis slop, `press` = 300ms hold, `immediate` claims on the press. **No pointer capture**: a release outside the canvas is caught by window `pointerup`/`mouseup` listeners, but moves while the pointer is off the canvas are not tracked. |
| Cancel | **Esc cancels only while the accessibility mirror has focus** — it is driven from the focus manager's mirror keydown path, so a mouse drag with no focused mirror element does not cancel on Esc (release outside every zone instead). `Remove`/`Detach` cancel as everywhere. |
| Ghost | `dndGhost` + `dndOffset` on the lifted item; `paint.ts` skips it in tree order and the renderer paints it **last** (above every sibling, unclipped); hit-testing skips it so the pointer sees what is under it. |
| Sibling shift | Per-node `dndOffset` (an outer translate on the subtree); snaps (no 150ms tween). Lists are rebuilt from the live children after a mid-drag engine insert/remove, as on the DOM. |
| Settle | **No FLIP settle** after the hold: when the engine's `Move` lands the offsets are dropped and the item appears in its slot (the Canvas has no `.layout()` FLIP), whereas the DOM animates from the ghost's rect. |
| Pinboard | `(x, y)` from the item's visual top-left; the ghost snaps to the resolved position for the hold. |
| Poses | Overlaid through the renderer's ordinary setProp path; base restored when the label clears. **Variant-qualified pose keys are applied** (through the renderer's variant machinery), not skipped — see the `.states { }` section above. |
| Keyboard | `KeyboardDragMachine` driven from the focus manager's keydown path; `aria-grabbed` is mirrored onto the accessibility mirror, and `describeKeyboard()` is exposed for hosts, but the renderer does **not** announce (no live region in v1). `describeKeyboard()` names a **foreign zone by its node id** (the machine's `describe()` verbatim); zone counts are captured at lift; no preview inside a foreign list. Not on pinboard items. |
| Accessibility mirror | The mirror elements keep their layout geometry: they do **not** follow the ghost's or shifted siblings' `dndOffset` (or a node's own translates) during a drag. |

### Desktop (Vello) capability matrix

`hypen-renderer-desktop/src/dnd.rs`, mirroring `DesktopScrubber`: `pre_ingest` runs first on every flush (dnd > scrub), winit pointer events drive the gesture, deadlines fire from the redraw ticker.

| Channel | Desktop behavior |
|---------|------------------|
| Input | Single OS cursor stands in for pointer capture (one drag at a time; every move routes to it until release; window focus loss is `pointercancel`). **No touch** (winit `Touch` not wired): `auto` is mouse slop; the cross-axis/long-press rules never apply. `handle:` is discarded at parse time (the lift surface is the source's own bounds — DOM parity). A `RemoveProp` of a translate key on the lifted node is not deferred. |
| Local offsets | Two renderer-private props (`__dndDesktop.dx/.dy`, never on the wire) folded into the node's own translate, so paint, `hit_contains`, `visual_rect`, and AccessKit bounds move together. |
| Ghost raise | The lifted subtree is painted last for the frame (fragment cache bypassed that frame). |
| Poses | Overlaid onto the real tree props and restored on clear; **pose switches and sibling shifts snap** (the synthesized transition is not honored for the runtime label). Variant-qualified keys skipped with a warning. |
| Keyboard | **Omitted** in v1 — Esc cancels a pointer drag; nothing lifts from the keyboard. |
| Events | Extra named args merge under the payload; `animate:` is passed through untouched (desktop clicks have no animate stamp). |

### iOS (SwiftUI) capability matrix

`hypen-renderer-swift/Sources/HypenSwift/DragAndDrop/` — `HypenDndCoordinator` (one per `HypenRenderer`) owns the state, `DndModifiers.swift` the pixels. Compiled and unit-tested on a Mac, including an iOS Simulator build. Device gesture and accessibility behavior still needs interactive validation.

| Channel | iOS behavior |
|---------|--------------|
| Gesture = activation | `slop`/`auto`-mouse ⇒ `DragGesture(minimumDistance: 6)`; `immediate` ⇒ `minimumDistance: 0`; `press`/`auto`-touch ⇒ `LongPressGesture(0.3s, maximumDistance: 6)` sequenced before the drag (travel first = scroll); `auto`-touch in an axis-constrained sortable ⇒ 6px drag with the cross-axis rule on the first sample. Recognition is pointer capture; a tap is a no-op and the node's `.onClick` still fires. |
| Pointer type | Platform-derived (SwiftUI exposes none): every non-macOS build is "touch", so an iPad trackpad drag follows the touch rules. One drag at a time. |
| Geometry | The host view names a coordinate space and resolves anchor frames for every DnD-relevant node; list geometry snapshotted at lift (rebuilt after a mid-drag engine insert/remove); content box = frame inset by margin + padding. Measured frames are **layout** rects: a node's own engine `translateX.0`/`translateY.0` is added back on every read, but **translate variants** (`translateX:hover`, `translateX@md`) are not folded into the rendered rect, and the runtime's own shift offsets are not in any entry — so a **shifted sibling row's own `.dropZone` is hit-tested at its pre-shift rect** (the DOM's `elementsFromPoint` sees the shifted row); a drop aimed "into" a folder row that has moved to open the gap can resolve as a reorder. |
| Shift / poses | `.offset` shifts glide 150ms ease-out; the label switch rides the synthesized `__anim.transition`; both snap under reduced motion. `zIndex` raise is within the parent container only — a ghost dragged out of a clipped container is clipped. Variant-qualified pose keys skipped with a one-time warning. |
| Mid-drag cancels | `__dnd.sourceEnabled` flipping to `false` **or the `__dnd.source` role itself vanishing** from the lifted node cancels silently (no `.onDragEnd`, no write), like `Remove`/`Detach`; during the post-drop hold both are ignored. |
| Not in v1 | Keyboard path (no lift, no live region — VoiceOver users reorder through the author's own controls); Esc cancel (a drop outside every zone cancels); autoscroll; deferral of a `RemoveProp` of a translate key on the lifted node (only translate `SetProp`s defer). Child controls (Button, Input) that own the touch beat an ancestor `.draggable` — put `.draggable()` on a grip node instead (`handle: true` alone changes nothing). |

### Android (Compose) capability matrix

`hypen-renderer-android/renderer/src/main/java/space/hypen/renderer/dnd/` — `DndCoordinator` (the twin of `AnimationCoordinator`, with a structural mirror of the tree fed by the renderer's patch hooks) decides what a gesture means; `HypenDnd.kt` wires one element's modifiers. **Not compiled in the build container** (no Android SDK); self-reviewed against the contract, JVM unit tests only.

| Channel | Android behavior |
|---------|------------------|
| Activation | The pending phase runs inside one `awaitEachGesture`: `auto` ⇒ mouse/pen 6dp any-axis slop; touch inside an axis-constrained sortable 6dp cross-axis slop (main-axis travel, or a parent scroll container consuming the move, abandons to the scroll); touch elsewhere 300ms press with a `LongPress` haptic on lift; `slop` / `press` / `immediate` override. Thresholds are the contract's 6dp / 300ms, not the platform `ViewConfiguration`. Below the threshold nothing is consumed — a tap is a total no-op, child clicks fire. From the claim on, every change of the claiming pointer is consumed (Compose's pointer capture). One drag (or its hold) at a time. |
| Ghost / shift | Per-element snapshot state read inside a `graphicsLayer {}` lambda (a drag frame costs no recomposition); the lifted item gets `zIndex(1f)`; sibling shifts tween 150ms while dragging (snap under the platform reduced-motion preference) and snap at release. `ForEach`/`Conditional` wrappers are flattened, so the item that moves is the container's direct child containing the source. |
| Geometry | `onGloballyPositioned` root-px bounds with the runtime's own offsets subtracted; pin `(x, y)` are converted to **dp** (the renderer's logical unit for `translateX`/`translateY`) before grid/clamp/fraction. **Lift surface = the element's rendered content box** (the `pointerInput` sits inside the applicator chain): a layout inset the author placed before the translate — `.padding(8).translateX(40)` — is not part of the hit region, whereas the DOM lifts from the padding area too. **Only the lowered `translateX.0`/`translateY.0` keys are folded into the rendered rect**; a `transform` shorthand translate or a pose that overrides `translateX.0` is not, so a note positioned that way re-pins from its untranslated layout box. A translate write re-reports the rect from a `LaunchedEffect`, **one composition later** than the write (a layer-only update never fires `onGloballyPositioned`). |
| Input | The drop is the **claiming pointer's** up, even with a second finger still down — a second finger never inherits the drag; the pointer vanishing, an inner detector consuming a move, or the system unwinding the gesture (`ACTION_CANCEL`, the node leaving the tree) is `pointercancel` (`.onDragEnd {dropped: false}`). `handle:` is parsed and not read (the grip is the source; the container's direct child moves). A `RemoveProp` of a translate key is not deferred. |
| Poses | `lifted` / `over` are a pose-override layer on the element *above* the glide overrides — an engine `SetProp` to an overridden key lands in the base at once and shows through on clear. **Pose switches snap** (the synthesized transition is not honored for the runtime label; desktop parity). **Variant-qualified pose keys are merged over the props like any other key** (not skipped, no warning) — see the `.states { }` section above. |
| Accessibility | A source inside a sortable exposes "Move up" / "Move down" (left/right for `axis: x`) TalkBack custom actions that run the exact pointer commit path (`.onDragStart` → `__hypen_reorder` → `.onSort` → `.onDragEnd`, then the hold). No live-region announcement. |
| Not in v1 | Keyboard drag (no Space/Arrow/Tab/Esc machine — the custom actions stand in); Esc does not cancel a pointer drag (the system `pointercancel` does); autoscroll. Sortables inside a `List` (`LazyColumn`/`LazyRow`) only see the rows Compose has composed — off-screen rows are not slots. `animate:` passes through unstamped. |

## Notes & Limits

- **Not in v1 (deliberate):** OS-level drags (files in from the desktop, items out to other apps — a separate, security-gated feature the surface is designed to admit later); multi-select drag; nested sortables (tree/outliner drag — the inner/outer hit-test ambiguity needs its own pass, though `path_move` already handles nested destinations); pan/zoom infinite canvases; autoscroll near a scroll edge.
- **Sort writes your array, full stop.** There is no order overlay: an internal order the screen shows but handlers don't see would make "delete the top item" delete the wrong one. A read-only data-source list therefore cannot be `.bind`-sorted — use `.onSort` and write elsewhere.
- **Persistence is the module's.** With `.persist(store)` the dragged order and the pins (reserved `__dnd` included) save on the same debounce and restore before `onCreated`; without it they reset on reload, exactly like a typed input value. The debounce caveat inherits unchanged: a drop followed within the window by a hard close can lose the last write.
- **Correctness never depends on the renderer.** Every outcome is a state write or an action; the ghost, the gap, and the highlight are transient. Design handlers as if the drop arrived from a keyboard — because on some renderers it did.
