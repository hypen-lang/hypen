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
- Each item may render as several children (a multi-node template). Group the children into items: `childrenPerItem = round(children.length / (end - start))`, at least 1; child `i` belongs to item `start + floor(i / childrenPerItem)`.
- Rows leaving the window arrive as plain `remove`s (never `transition: true`); remove them immediately.
- The prop is never stored as an ordinary prop on the node: never echo it back, never diff it.

## 2. Renderer layout

- **Scroll axis**: vertical, unless the element lays out horizontally (`Row`, `List(direction: horizontal)`). A `Grid` with `columns: n` lays items out in rows of `n`: item `i` is in row `floor(i / n)`, so its padding is counted in rows.
- **Stand-ins are padding, never sibling nodes.** The engine appends new rows with `before_id: none`; a trailing spacer element would end up before them. Use `padding-top`/`padding-bottom` (or `-left`/`-right`) on the list element, `contentPadding` on Compose's `LazyColumn`, or padding on SwiftUI's `LazyVStack`. Native lazy containers may instead show `total` slots with placeholders of the estimated size (see §5).
- **Estimating**: `itemSize` = the average measured size of the materialized items (for a grid, of the rows they occupy: `windowRows`), else `estimatedSize`, else **48** (px / pt). Leading padding = `start × itemSize`; trailing padding = `(total − end) × itemSize`. A per-index cache of measured sizes is allowed, but the average alone is correct enough.
- **Scroll anchoring**: when a window change alters the leading padding, keep the first visible materialized row at the same screen position by adjusting the scroll offset by the difference.
- **Accessibility**: rows should expose the full list position (`aria-setsize = total`, `aria-posinset = item index + 1`, or the platform equivalent).
- Off-screen items do not exist, so browser find-in-page does not find them. That is the accepted trade-off.

## 3. Renderer → engine: the viewport report

Compute the range of items the user can see, widened by overscan, and report it.

1. **Scroll container**: the list element if it scrolls itself; otherwise its nearest scrolling ancestor; otherwise the window / root view. Account for the list's offset inside that container.
2. **Visible range**: `visibleStart = floor(scrolledPast / itemSize)`, `visibleEnd = ceil((scrolledPast + viewportExtent) / itemSize)`, clamped to `[0, total]`, where `scrolledPast` is how far the container has scrolled past the list's top edge (0 if it hasn't). While the list starts below the top of the viewport, only the part of the viewport over the list counts: `viewportExtent` shrinks by that distance. Refine with the measured positions of materialized rows when the range overlaps them.
3. **Overscan**: widen both sides by one viewport's worth of items, at least **5** items.
4. **Report** `setListViewport(listId, wantStart, wantEnd)` (the overscanned range) when the visible range is not inside the current `[start, end)`, or when the current window is more than three times the overscanned range (shrink after a fling). Never report the same range twice in a row, but forget the last report whenever `__virt.window` changes value: the engine may move the window on its own (e.g. `total` changed) to exactly the range last reported, and the renderer must still be able to ask again. This repeats a report at most once — a report that moves nothing produces no new window.
5. **When**: after the list first lays out, on scroll (at most once per frame), on resize, and whenever `__virt.window` changes and the current window no longer covers the needed range.

`listId` is the id of the element carrying `__virt.window`. Ids naming no windowed list are ignored by the engine, so a stale report is harmless. A report computed just before items were inserted above may be off by the shift; the next report corrects it.

The shared math is in `@hypen-space/core` (`packages/core/src/virtualization.ts`). Native renderers port it (it is a few lines) and keep their port's tests aligned with `tests/virtualization-math.test.ts`:

| Function | Contract |
|---|---|
| `parseVirtWindow(value)` | Decode `__virt.window`; `null` when malformed (ignore it). |
| `childrenPerItem(window, childCount)` | §1 grouping. |
| `windowRows(window, columns)` | Rows the materialized items occupy (the divisor for a measured average). |
| `itemSize(window, measuredTotal, measuredCount)` | §2 estimating. |
| `windowPadding(window, size, columns)` | §2 leading / trailing padding. |
| `visibleRange`, `wantedRange`, `shouldReport` | §3 steps 2–4. |
| `windowChanged(previous, next)` | §3 step 4: whether an incoming `__virt.window` differs in value (`total`, `start`, `end`, `estimatedSize`) from the previous one, so the renderer forgets its last report. `true` when there was no previous window. |
| `viewportReport(window, geometry, lastReported)` | Steps 2–4 in one call (with the below-the-top rule of step 2): the range to send now, or `null`. The caller keeps what it sent as `lastReported`. |

## 4. Remote protocol

A remote client reports viewports to the server with one message:

```json
{ "type": "viewport", "listId": "4294967301", "start": 40, "end": 70 }
```

Server rules (every server SDK):

- Accept it only after `hello`. Ignore it otherwise, like `dispatchAction`.
- `start`/`end` are non-negative integers; clamp them to `u32` and ignore a malformed message (no error, no disconnect).
- Call `setListViewport(listId, start, end)` on **this session's engine only**. The resulting patches stream back as ordinary `patch` messages. A viewport is per client: never replay it to other sessions (`syncActions`), never treat it as an action, and never send a `stateUpdate` because of it.

Every server (TypeScript, Go, Kotlin, Swift, Rust) behaves identically, pinned by each SDK's tests:

| Case | Behaviour |
|---|---|
| Before `hello` | Ignored; nothing sent |
| `listId` missing, empty, or not a string | Malformed: ignored, no error, no disconnect |
| Bound negative, fractional, string, bool, null or missing | Malformed: ignored |
| Bound written `-0`, `40.0`, `4e1` | Accepted (it is an integer) |
| Bound above `u32` | Clamped to `u32` |
| `start > end` | Forwarded; the engine materializes one item, `[start, start + 1)` |
| Unknown or stale `listId` | No patch, no revision bump |
| Report that moves nothing | No message, no revision bump |
| Report that moves the window | One ordinary `patch` at revision + 1, to the reporting connection only |
| Other sessions, `syncActions`, `allow-multiple` peers | Never sent there; never an action |
| `stateUpdate` | Never sent |
| Engine error | Logged and dropped; no disconnect, no revision bump |

There is no capability negotiation: every client must send viewports, and every server must handle them.

## 5. Native lazy containers

Compose `LazyColumn` / `LazyRow` / `LazyVerticalGrid` and SwiftUI `LazyVStack` / `LazyHStack` / `LazyVGrid`:

- Declare `total` slots. Slot `i` renders the materialized child for item `i` when `start ≤ i < end`, else a placeholder sized `itemSize` (§2).
- Report from the container's own visibility (Compose `LazyListState.layoutInfo.visibleItemsInfo` via `snapshotFlow`; SwiftUI `onAppear`/`onDisappear` per slot, or `onScrollGeometryChange`), apply the overscan and reporting rules from §3, and call the engine's `setListViewport` (local engine) or send the `viewport` message (remote).
- Key slots by item index for placeholders and by the child's node id for materialized rows.
