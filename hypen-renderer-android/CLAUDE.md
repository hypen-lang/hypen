# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Android renderer.

## Project Overview

`hypen-renderer-android` is a Jetpack Compose renderer for Hypen. It connects to a Hypen server via WebSocket, receives patches, and renders native Android UI. This is the reference implementation for native rendering, parallel to `hypen-renderer-swift` (iOS).

## Module Structure

```
hypen-renderer-android/
├── renderer/                          # Core library (AAR)
│   └── src/main/java/com/hypenspace/renderer/
│       ├── HypenApp.kt               # App entry point composable
│       ├── render/
│       │   ├── ComposeRenderer.kt     # Main Compose rendering tree
│       │   ├── Renderer.kt           # Renderer interface
│       │   └── HypenLocals.kt        # CompositionLocal providers
│       ├── model/
│       │   ├── HypenElement.kt       # Element data structure
│       │   ├── Patch.kt              # Patch operations
│       │   └── RemoteMessage.kt      # WebSocket message types
│       ├── remote/
│       │   ├── RemoteEngine.kt       # WebSocket client (OkHttp, permessage-deflate)
│       │   ├── RemoteEngineConfig.kt # Connection configuration
│       │   ├── MessageParser.kt      # JSON message parser
│       │   └── ConnectionState.kt    # Connection state enum
│       ├── components/               # ~31 component implementations
│       │   ├── TextComponent.kt
│       │   ├── ColumnComponent.kt
│       │   ├── RowComponent.kt
│       │   ├── ButtonComponent.kt
│       │   ├── InputComponent.kt
│       │   └── ...
│       ├── applicators/              # Style applicators
│       │   ├── PaddingApplicator.kt
│       │   ├── MarginApplicator.kt
│       │   ├── TextApplicators.kt
│       │   ├── BorderApplicators.kt
│       │   └── ...
│       ├── routing/
│       │   └── RouterController.kt   # Client-side routing
│       ├── fonts/
│       │   └── GoogleFontsLoader.kt  # Dynamic font loading
│       └── HypenLogger.kt           # Logging
│
├── app/                              # Example app
│   └── src/main/java/.../
│       ├── MainActivity.kt
│       ├── ComponentListActivity.kt
│       └── HypenAppEntry.kt
│
└── server/                           # Sample Bun dev server
    └── index.ts
```

## Development Commands

```bash
# Start the dev server (provides components to the app)
cd server && bun install && bun run start

# Build the renderer library
./gradlew :renderer:build

# Run the example app (use Android Studio)
# Open project in Android Studio, select 'app' module, Run

# Publish locally
./gradlew :renderer:publishToMavenLocal

# All renderer unit tests, including the Compose UI tests (JVM, Robolectric)
./gradlew :renderer:testDebugUnitTest
# Only the rendering tests
./gradlew :renderer:testDebugUnitTest --tests '*RenderTest'
```

### Compose UI tests (Robolectric)

Composables are rendered for real in plain unit tests: Robolectric 4.14.1
(`libs.versions.toml`) + `androidx.compose.ui:ui-test-junit4` (Compose BOM)
with `ui-test-manifest` on `debugImplementation`, and
`unitTests.isIncludeAndroidResources = true`. Tests run on API 34
(`src/test/resources/robolectric.properties`). Robolectric's
`android-all-instrumented` jars (API 34, plus API 35 which it reads resources
from) are resolved by Gradle through the `robolectricAndroidAll`
configuration and copied to `renderer/build/robolectric-android-all`; tests run
with `robolectric.offline=true` pointed there, so they work behind the same
repository mirrors as the rest of the build. Changing the Robolectric version
means updating those two coordinates in `renderer/build.gradle.kts`.

Write them with `@RunWith(RobolectricTestRunner::class)` and
`createComposeRule()`; `HypenUiTestSupport.kt` mounts a `ComposeRenderer`
through `HypenRoot` (what `HypenApp` renders once connected) with
`setHypenContent`, applies patch batches with `rule.apply(renderer, patches)`,
and has a `FakeViewportEngine` for viewport reports. Use
`@Config(qualifiers = "w400dp-h800dp-mdpi")` so dp == px. Existing:
`RootChildrenRenderTest`, `ChildListRenderTest`, `virt/VirtLazyListRenderTest`,
`virt/VirtPaddedRenderTest`, `virt/VirtShapesRenderTest`, `virt/VirtUnboundedRenderTest`.

## Architecture

### Data Flow

```
Hypen Server (WebSocket)
    ↓ JSON messages
RemoteEngine (OkHttp WebSocket)
    ↓
MessageParser → initialTree / patches
    ↓
ComposeRenderer
    ├── ComponentRegistry.getHandler(elementType)
    ├── ApplicatorRegistry.applyAll(modifier, element)
    └── Jetpack Compose UI tree
```

### Key Patterns

- **ComponentRegistry** — maps element type names to Compose component handlers
- **ApplicatorRegistry** — maps style names to Modifier transformations
- **RemoteEngine** — manages WebSocket lifecycle, reconnection, message dispatch
- **HypenElement** — tree node with props, children, parent references

### Adding New Components

1. Create a component handler class implementing the component interface
2. Register in `ComponentRegistry`
3. Test via `component-gallery-server`

### Adding New Applicators

1. Create an applicator class that transforms Compose `Modifier`
2. Register in `ApplicatorRegistry`

## Detach/Attach Patch Handling

`PatchType.DETACH` / `PatchType.ATTACH` are emitted by the engine's
Router subtree cache so navigating between routes doesn't tear down
Compose nodes. Handled in `ComposeRenderer.onDetach` / `onAttach`
(see `renderer/src/main/java/space/hypen/renderer/render/ComposeRenderer.kt`):

- **`onDetach(id)`** — unlinks `id` from its parent's `children`
  list but keeps the `HypenElement` and its entire subtree in the
  `elements` map under the same id.
- **`onAttach(parentId, id, beforeId)`** — reinserts the still-alive
  element. Compose recomposes through the recursive element renderer
  without going through `onCreate`.

A `PatchType.REMOVE` arriving for a detached id (engine LRU eviction)
tears down normally via `onRemove`, which also evicts from `detachedIds`.

### Root children

The "root" mount container can hold several ordered nodes (control flow at
the IR root with siblings). `ComposeRenderer` keeps them as a snapshot-backed
list (`getRootChildIds()`; `getRootId()` is the first): Insert / Move / Attach
into "root" place by `beforeId` (unknown or absent anchor appends), Detach and
Remove drop the id, and an animated-exit root keeps its slot until finalize.
`HypenApp.HypenRootChildren` renders them through one stable `Layout` with
`key(id)` per root (no remount across one <-> several roots): one root gets the
host Box's policy (loose constraints, TopStart, parent data ignored — identical
to before); several stack vertically with `.weight` via `RootColumnScope`.
`hasRendered()` latches on the first root placement (reset by `clear()`): the
loading content shows only before it, and an empty root afterwards renders
nothing, like the DOM container. `HypenRoot` is the connected-state body
(root children or loading). Tests: `RootChildrenTest` (patch level) and
`RootChildrenRenderTest` (rendered: order, `beforeId`, a root keeps its
`remember`ed state while siblings toggle, the loading latch).

### Child lists in composition

`ComposeRenderer.getChildren` reads the snapshot-backed
`HypenElement.children`, so the composable that renders a child list
recomposes when it changes. `HypenElement.childIds` (the canonical linked
order) is for code applying a batch only: it is not snapshot state, and
reading it from composition left a batch that only inserted / removed / moved
rows unrendered (`ChildListRenderTest`).

### Strategy 3 hook (limbo container)

`ComposeRenderer.getDetachedIds(): List<String>` is exposed so a
future `HypenApp.kt` root composable can render detached subtrees in
a hidden `Box` overlay (`Modifier.size(0.dp).alpha(0f)`) keyed by
`key(id) { ... }`. This would preserve `remember`,
`rememberScrollState` / `rememberLazyListState`, focus, and
animations across the detach → attach cycle. Not implemented today;
ship if/when scroll-position loss becomes a real complaint.

## List Virtualization (`__virt.window`)

Always on (contract: `hypen-web/docs/virtualization.md`). The engine windows
every List/Grid/lazy ForEach and sets `__virt.window` = `{total,start,end,
estimatedSize?}` on the list element; it stays in the element's props (so it
commits atomically with the batch's rows) but no applicator handles it.

- `virt/Virtualization.kt` — plain-Kotlin port of `@hypen-space/core/virtualization`
  (parseVirtWindow, childrenPerItem, windowRows, itemSize, windowPadding,
  visibleRange, wantedRange, shouldReport, viewportReport, windowChanged — same names and cases as the TS reference and the Swift port
  `Virtualization/VirtualizationMath.swift`), plus the slot mapping
  (`VirtSlots`, O(1), resolved on demand), report state (`ViewportTracker`),
  the padded-path geometry (`paddedItemSize`, `paddedVisibleRange`,
  `anchorDelta`), `collectionShape`, and
  `WindowedShape`. `VirtualizationMathTest` mirrors
  `hypen-web/tests/virtualization-math.test.ts` case for case — keep aligned;
  `VirtAnchorTest` covers `anchorDelta` / `collectionShape` /
  `itemPosition` / `childPositions`.
- `virt/VirtCompose.kt` — Compose glue. Lazy shape (`List`/`Grid` that scroll,
  and a scrollable Column/Row via `WindowedLazyList` from `HypenElement`):
  `total` slots, rows keyed by node id, placeholders by item index, reports
  from `layoutInfo` via `snapshotFlow`; each row is wrapped in `VirtItem`
  (layout-transparent) carrying its whole-list `collectionItemInfo`. Padded
  shape (any other windowed container): `Modifier.virtPadded` pads
  leading/trailing and reports from the clipped bounds in root. The padded
  list (padding + the window's rows) is capped at `MAX_PADDED_EXTENT_DP`
  (Compose's 2^18 px `Constraints` limit at density 4) by shrinking the
  per-row padding (`paddedItemSize`); `paddedVisibleRange` maps offsets back
  through the same sizes.
- Reports go `ComposeRenderer.reportViewport` → `ViewportReporter` →
  `RemoteEngine.setListViewport` → `{"type":"viewport","listId","start","end"}`
  (dropped while disconnected; the list re-reports from its scroll state).
- DnD: a sortable / pinboard inside a windowed list names whole-list indices
  in its reserved writes (`__hypen_reorder`, `bind.<i>` pin paths) and event
  locations: window-relative child index + `__virt.window.start`
  (`DndCoordinator.virtStarts` / `absIndexLocked`).
- Report state: `ViewportTracker` forgets its last report whenever
  `__virt.window` changes value (`windowChanged`, §3 step 4); an identical
  re-send does not reset it.
- Scroll anchoring (§2) on the padded path: every scroller a windowed list can
  sit in (scrollable Column/Row `ScrollState`, List/Grid lazy states) provides
  itself through `ProvideVirtScroller` / `LocalVirtScrollers`. When the window
  or the per-row padding changes, `virtPadded` scrolls the nearest scroller on
  its axis (`dispatchRawDelta`, in a `SideEffect` before layout; any part the
  scroller clamps is applied after the next layout) by
  `Virtualization.anchorDelta` — the padding delta minus the anchor row's shift
  inside the window, computed from the last layout's geometry with rows at the
  measured average size. The lazy path relies on `LazyListState`'s own
  key/index anchoring.
- Accessibility: `Modifier.virtCollectionInfo` sets the container's
  `collectionInfo` from `Virtualization.collectionShape` (`total` rows for a
  list, 1×`total` horizontally, `ceil(total/columns)`×`columns` for a grid) on
  both paths. On the lazy path it must be in the `modifier` passed to the lazy
  container: ui 1.7 applies a node's semantics modifiers tail-to-head, so the
  outer one overrides the lazy layout's own `-1` (unknown) count. Each row
  carries its whole-list `collectionItemInfo` from `Virtualization.itemPosition`
  on both paths: lazy rows via `VirtItem`; padded rows without a wrapper — the
  padded container provides `childPositions` (child id → cell, §1 grouping)
  through `ProvideVirtItemPositions` / `LocalVirtItemPositions`, and
  `HypenElement` adds `virtItemInfo` to a listed row's own modifier.

Rendered tests: `VirtLazyListRenderTest` (a windowed `List`: only visible rows
composed, `performScrollToIndex` reports the expected range, a new window
materializes the rows in place, `removeProp` unwindows, `CollectionInfo` /
whole-list `CollectionItemInfo`) and `VirtPaddedRenderTest` (a windowed
`Column { ForEach }` in a scrollable `Column`: padding sizes, report on outer
scroll, anchoring keeps the first visible row's on-screen position across a
window move, padded rows' `CollectionItemInfo`), `VirtShapesRenderTest` (lazy
`Grid` rows x columns, horizontal `List`, self-scrolling windowed `Column` /
`Row`, padded anchoring inside a lazy `List`) and `VirtUnboundedRenderTest`.

Lazy vs padded is decided from constraints, not the element tree:
`LazyOrPadded` (`BoxWithConstraints`, the element's modifier on the box with
min constraints propagated) lays a would-be lazy container (`List` that
scrolls, `.scrollable(true)` `Grid`, horizontal `List`, windowed scrollable
`Column` / `Row`) out lazily only when its main axis is bounded. Unbounded —
inside an ancestor scroller on the same axis with no size of its own — it
renders padded and scrolls with the ancestor (a lazy container there threw
"measured with an infinity maximum height/width"); a scrollable Column / Row
drops its own scroll modifier there via `LocalSuppressOwnScroll`.

Known gaps:
- Anchoring assumes LTR for horizontal lists and approximates the rows above
  the anchor by the measured average size.
- Not yet rendered in tests: multi-node item templates (several children per
  item), padded horizontal anchoring, DnD inside a windowed list, and
  `HypenApp` itself (session / connection states — the tests mount
  `HypenRoot`).
- A non-windowed `.scrollable(true)` Column / Row nested in a scroller on the
  same axis with no size of its own still hits Compose's unbounded-scroll
  check (only the windowed case falls back).

## Device Capability Protocol (RFC 001)

`renderer/.../device/` is the Android DeviceHost: a JVM-pure protocol core
(`DeviceHost.kt`, `DeviceProtocol.kt`, `DevicePayloads.kt`,
`DeviceHandshake.kt`, `CapabilityDrivers.kt`, and the capture
drivers `CaptureDrivers.kt` / `CaptureSupport.kt`: file.pick, file.save with
the download plane, camera.capture, mic.record, bluetooth.select) plus Android
glue in `device/android/` (`CapturePlatforms.kt` holds SAF, the capture
intents with `HypenDeviceFileProvider` — declared in the renderer manifest —
and `AudioRecord`). Driver behaviour is tested through fakes of the platform
seams in `DeviceCaptureDriversTest.kt`. Strict device JSON (RFC 001 §2.1 limits) is
`remote/StrictDeviceJson.kt`. The unit tests replay the shared corpus in
`engine-compatibility-tests/fixtures/device/` with no skips:
`DeviceConformanceTest.kt` (messages, handshake, payloads, selection) and
`DeviceTranscriptTest.kt` (every transcript, the Android client as one
endpoint). Run them with `./gradlew :renderer:testDebugUnitTest --tests 'space.hypen.renderer.device.*'`.

## Key Dependencies

- Jetpack Compose (BOM)
- OkHttp (WebSocket) — 4.12.0; always offers `permessage-deflate`, so patch
  frames are compressed automatically. The offer cannot be suppressed client-side
  (OkHttp hardcodes it and rejects a caller-supplied `Sec-WebSocket-Extensions`
  header), so `RemoteEngineConfig` intentionally has no `compression` flag —
  disable it server-side instead. See README "Compression". The device plane
  runs on a compressed socket only when the negotiated permessage-deflate has
  both `server_no_context_takeover` and `client_no_context_takeover`
  (`remote/PerMessageDeflate.kt`, tests in `RemoteEngineCompressionDeviceTest`);
  otherwise the hello omits `device` (UI-only, one warning).
- Kotlin serialization (JSON)
- CameraX + ML Kit (QR scanning in example app)
