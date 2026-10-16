# List Virtualization

`List` and `Grid` are virtualized out of the box, and so is `ForEach(…, lazy: true)`. The engine materializes only a **window** of a long list's items — creates their nodes, tracks their bindings, sends their patches — and tells the renderer how big the whole list is. The renderer lays out the window, stands in for the rest with padding, and reports back which items are visible as the user scrolls. Over the network that means a 10,000-row list costs about as much as the rows on screen.

App code changes nothing:

```hypen
List(@state.messages, key: "id") { MessageRow("@{item.text}") }          // virtualized
Grid(@state.photos, key: "id", columns: 3) { Thumb("@{item.url}") }       // virtualized
List(@state.steps, key: "id", lazy: false) { Step("@{item.title}") }      // opt out: every row
Column { ForEach(items: @state.rows, key: "id", lazy: true) { Row("@{item.name}") } }
```

| Argument | Default | Meaning |
|---|---|---|
| `lazy:` | `true` on `List`/`Grid`, `false` on `ForEach` | Literal `true`/`false` only; a binding is an error. |
| `initialCount:` | `30` | Items materialized before the renderer's first viewport report. |
| `estimatedItemSize:` | none | Optional size hint (px / pt) for rows not measured yet. Never required. |

A lazy `ForEach` is windowed only when it is the **sole child** of a real element (always true for `List`/`Grid`); next to siblings it renders every row.

There is no switch to turn virtualization on or off: **every renderer and every remote client must implement this contract.** `lazy: false` is the only opt-out, per list.

The rest of this page is the contract renderer and SDK authors implement.

## 1. Engine → renderer: `__virt.window`

The engine sets one reserved prop on the list's element (the `List`/`Grid` node, or the element whose only child is a lazy `ForEach`):

```json
"__virt.window": { "total": 10000, "start": 40, "end": 70, "estimatedSize": 48 }
```

| Field | Meaning |
|---|---|
| `total` | Items in the whole list. |
| `start`, `end` | The element's children are exactly the items `[start, end)`, in order. |
| `estimatedSize` | Present only when the template gave `estimatedItemSize:`. |

- It arrives as an ordinary `setProp`, in the same batch as the row `create`/`instantiate`/`insert`/`remove` patches it describes. Apply it **after** the batch's structural patches.
- `removeProp` of `__virt.window` means the list is no longer windowed: drop the padding and render the children as a normal container.
- Each item may render as several children (a multi-node template). Group the children into items: `childrenPerItem = children.length / (end - start)`.
- Rows leaving the window arrive as plain `remove`s (never `transition: true`); remove them immediately.
- The prop is never stored as an ordinary prop on the node: never echo it back, never diff it.

## 2. Renderer layout

- **Scroll axis**: vertical, unless the element lays out horizontally (`Row`, `List(direction: horizontal)`). A `Grid` with `columns: n` lays items out in rows of `n`: item `i` is in row `floor(i / n)`, so its padding is counted in rows.
- **Stand-ins are padding, never sibling nodes.** The engine appends new rows with `before_id: none`; a trailing spacer element would end up before them. Use `padding-top`/`padding-bottom` (or `-left`/`-right`) on the list element, `contentPadding` on Compose's `LazyColumn`, or padding on SwiftUI's `LazyVStack`. Native lazy containers may instead show `total` slots with placeholders of the estimated size (see §5).
- **Estimating**: `itemSize` = the average measured size of the materialized items, else `estimatedSize`, else **48** (px / pt). Leading padding = `start × itemSize`; trailing padding = `(total − end) × itemSize`. A per-index cache of measured sizes is allowed, but the average alone is correct enough.
- **Scroll anchoring**: when a window change alters the leading padding, keep the first visible materialized row at the same screen position by adjusting the scroll offset by the difference.
- **Accessibility**: rows should expose the full list position (`aria-setsize = total`, `aria-posinset = item index + 1`, or the platform equivalent).
- Off-screen items do not exist, so browser find-in-page does not find them. That is the accepted trade-off.

## 3. Renderer → engine: the viewport report

Compute the range of items the user can see, widened by overscan, and report it.

1. **Scroll container**: the list element if it scrolls itself; otherwise its nearest scrolling ancestor; otherwise the window / root view. Account for the list's offset inside that container.
2. **Visible range**: `visibleStart = floor(scrolledPast / itemSize)`, `visibleEnd = ceil((scrolledPast + viewportExtent) / itemSize)`, clamped to `[0, total]`, where `scrolledPast` is how far the container has scrolled past the list's top edge (0 if it hasn't). Refine with the measured positions of materialized rows when the range overlaps them.
3. **Overscan**: widen both sides by one viewport's worth of items, at least **5** items.
4. **Report** `setListViewport(listId, wantStart, wantEnd)` when the overscanned range is not inside the current `[start, end)`, or when the current window is more than three times the overscanned range (shrink after a fling). Never report the same range twice in a row.
5. **When**: after the list first lays out, on scroll (at most once per frame), on resize, and whenever `__virt.window` changes and the current window no longer covers the needed range.

`listId` is the id of the element carrying `__virt.window`. Ids naming no windowed list are ignored by the engine, so a stale report is harmless. A report computed just before items were inserted above may be off by the shift; the next report corrects it.

The shared math is in `@hypen-space/core` (`packages/core/src/virtualization.ts`): `windowPadding`, `visibleRange`, `wantedRange`, `shouldReport`. Native renderers port it (it is a few lines) and keep their port's tests aligned with `tests/virtualization-math.test.ts`.

## 4. Remote protocol

A remote client reports viewports to the server with one message:

```json
{ "type": "viewport", "listId": "4294967301", "start": 40, "end": 70 }
```

Server rules (every server SDK):

- Accept it only after `hello`. Ignore it otherwise, like `dispatchAction`.
- `start`/`end` are non-negative integers; clamp them to `u32` and ignore a malformed message (no error, no disconnect).
- Call `setListViewport(listId, start, end)` on **this session's engine only**. The resulting patches stream back as ordinary `patch` messages. A viewport is per client: never replay it to other sessions (`syncActions`), never treat it as an action, and never send a `stateUpdate` because of it.

There is no capability negotiation: every client must send viewports, and every server must handle them.

## 5. Native lazy containers

Compose `LazyColumn` / `LazyRow` / `LazyVerticalGrid` and SwiftUI `LazyVStack` / `LazyHStack` / `LazyVGrid`:

- Declare `total` slots. Slot `i` renders the materialized child for item `i` when `start ≤ i < end`, else a placeholder sized `itemSize` (§2).
- Report from the container's own visibility (Compose `LazyListState.layoutInfo.visibleItemsInfo` via `snapshotFlow`; SwiftUI `onAppear`/`onDisappear` per slot, or `onScrollGeometryChange`), apply the overscan and reporting rules from §3, and call the engine's `setListViewport` (local engine) or send the `viewport` message (remote).
- Key slots by item index for placeholders and by the child's node id for materialized rows.
