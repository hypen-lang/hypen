# CLAUDE.md

This file provides guidance to Claude Code when working with the HypenSwift package.

## Project Overview

HypenSwift is a SwiftUI renderer for the Hypen declarative UI language. It's a Swift port of `hypen-renderer-android` (Jetpack Compose-based), enabling native Apple platform rendering through WebSocket communication with a Hypen engine server.

## Directory Structure

```
hypen-renderer-swift/
├── Package.swift              # Swift 6 package manifest
├── README.md                  # User documentation
├── CLAUDE.md                  # This file
└── Sources/HypenSwift/
    ├── HypenSwift.swift       # Public exports
    ├── HypenView.swift        # Main entry point view
    ├── HypenElementView.swift # Recursive element renderer
    ├── Model/
    │   ├── HypenElement.swift # Element data structure
    │   ├── Patch.swift        # Patch operations for tree updates
    │   └── ActionValue.swift  # Action parsing from props
    ├── Device/                      # RFC 001 DeviceHost (separate from rendering)
    │   ├── DeviceWire.swift         # Wire types, 12-byte frame codec, client registry subset
    │   ├── DeviceStrictJSON.swift   # Strict JSON limits parser + tree decoder (no JSONDecoder on device input)
    │   ├── DevicePayloads.swift     # Per-revision params/result/event validation
    │   ├── RemoteHandshake.swift    # hello, resume credential, upgrade request, socket lifecycle
    │   ├── DeviceHost.swift         # Protocol core: admission, leases, cancel, upload scheduler
    │   ├── DeviceDrivers.swift      # Drivers + backend protocols (picker/consent/permissions/BLE)
    │   ├── DeviceCaptureDrivers.swift # file.pick/file.save/camera.capture/mic.record/bluetooth.select + seams
    │   ├── DeviceActivityOverlay.swift # Host-owned activity indicator (entries, Stop, lost overlay) over a surface seam
    │   ├── DeviceFileClone.swift    # Coordinated, size-checked private mapped clones (never map a picked original)
    │   ├── DeviceSupport.swift      # SHA-256, clocks, prompt gate, grant/cooldown store
    │   ├── DeviceHostIOS.swift      # iOS backends (PHPicker, UIAlert, AV/Photos/UN/CB/CL/CN), factory, #if os(iOS)
    │   └── DeviceHostIOSCapture.swift # iOS backends (UIDocumentPicker, UIImagePicker, AVAudioEngine, BLE chooser, indicator overlay)
    ├── Remote/
    │   ├── RemoteEngine.swift       # WebSocket client
    │   ├── RemoteEngineConfig.swift # Connection configuration
    │   └── ConnectionState.swift    # Connection state enum
    ├── Render/
    │   ├── HypenRenderer.swift      # Element tree management
    │   ├── ComponentRegistry.swift  # Component handler registry
    │   ├── ApplicatorRegistry.swift # Applicator handler registry
    │   ├── HypenModifier.swift      # Style accumulator with custom border drawing
    │   ├── ActionDispatcher.swift   # Action dispatch protocol
    │   └── ColorParser.swift        # Color string parsing
    ├── Routing/
    │   └── RouterController.swift   # Client-side router with history management
    ├── Components/
    │   ├── LayoutComponents.swift      # Column, Row, Box, Stack, etc.
    │   ├── ContentComponents.swift     # Text, Image, Divider
    │   ├── InteractiveComponents.swift # Button
    │   ├── RouterComponents.swift      # Router, Route, Link (router-aware)
    │   ├── FormComponents.swift        # Input, Checkbox, Slider, etc.
    │   ├── UIComponents.swift          # Card, Spinner, Badge, Avatar
    │   ├── MediaComponents.swift       # Audio, Video (AVFoundation/AVKit)
    │   ├── VideoPlayback.swift         # Video v2 pure logic (state machine,
    │   │                               #   queue/completed, bind throttle +
    │   │                               #   epsilon, slot table, scrubber math)
    │   └── ScrubberComponent.swift     # Scrubber (Video `controls` slot chrome)
    └── Applicators/
        ├── SpacingApplicators.swift      # padding, margin
        ├── SizeApplicators.swift         # width, height, fill*, aspectRatio
        ├── ColorApplicators.swift        # backgroundColor, foregroundColor
        ├── GradientApplicators.swift     # linearGradient, radialGradient, conicGradient
        ├── BackgroundApplicators.swift   # backgroundImage, backgroundSize, backgroundPosition
        ├── BorderApplicators.swift       # border, borderRadius, borderStyle (dashed/dotted/double)
        ├── LayoutApplicators.swift       # alignment, weight, flex, gap, rowGap, columnGap
        ├── VisualEffectApplicators.swift # opacity, shadow, blur, boxShadow, clipToBounds
        ├── TransformApplicators.swift    # rotate, scale, translateX, translateY, transform
        ├── EventApplicators.swift        # onClick, onLongPress
        └── TextApplicators.swift         # fontSize, fontWeight, etc.
```

## Development Commands

```bash
cd hypen-renderer-swift

# Build the package
swift build

# Run tests
swift test

# Build for release
swift build -c release

# Clean build artifacts
swift package clean
```

## Architecture

### Data Flow

```
WebSocket Server
       │
       ▼ (JSON messages)
RemoteEngine (URLSessionWebSocketTask)
       │
       ├─► initialTree message ─► HypenRenderer.setInitialTree()
       ├─► patch message ─────► HypenRenderer.applyPatches()
       └─► stateUpdate ────────► Published state dictionary

HypenRenderer (ObservableObject)
       │
       ▼ (element lookups)
HypenElementView (recursive)
       │
       ├─► ComponentRegistry.getHandler(elementType)
       ├─► ApplicatorRegistry.applyAll(modifier, element)
       └─► ComponentHandler.render(context, modifier, children)
              │
              ▼
         SwiftUI View
```

### Transport: compression is not ours to control

`RemoteEngine` uses `URLSessionWebSocketTask`. URLSession offers
`Sec-WebSocket-Extensions: permessage-deflate` in the handshake on its own and
inflates compressed frames transparently, with **no public API to enable,
disable, or parameterise it** — no property on the task, and the `Sec-*`
handshake headers cannot be set on the `URLRequest`.

So `RemoteEngineConfig` intentionally has no `compression` option (the other
Hypen client SDKs do have one). Do not add one — there is nothing to wire it
to. Whether a connection is compressed is decided by the server: enabled Hypen
servers compress automatically, `hypen-server-swift` declines and the
connection runs uncompressed. Switching to a third-party WebSocket client to
regain control is out of scope. The device plane is allowed on a compressed
socket only when the 101 response carries both `server_no_context_takeover`
and `client_no_context_takeover` (`RemoteDevicePlane.compressionSharesContext`,
the same rule as the web and Android clients). See the note in
`RemoteEngine.establishConnection()`.

### Key Protocols

```swift
// Component rendering
public protocol ComponentHandler: Sendable {
    var typeName: String { get }
    func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView
}

// Style application
public protocol ApplicatorHandler: Sendable {
    var name: String { get }
    func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext)
}

// Action dispatch
public protocol ActionDispatcher: Sendable {
    func dispatch(action: String, payload: [String: Any]?)
}
```

### Property Access Pattern

Props come from the engine with `.0` suffix for the first value:

```swift
// Access props with fallbacks
let text = element.getStringProp("text.0")
    ?? element.getStringProp("text")
    ?? ""

let width = element.getCGFloatProp("width.0")
let enabled = element.getBoolProp("enabled.0") ?? true
```

### Modifier Application

All styling flows through `HypenModifier`:

```swift
var modifier = HypenModifier()
applicatorRegistry.applyAll(to: &modifier, element: element, context: context)

// In component:
return AnyView(
    MyView()
        .hypenModifier(modifier)  // Applies all accumulated styles
)
```

## Swift 6 Concurrency Patterns

This package uses Swift 6 strict concurrency. Key patterns:

### MainActor Isolation

UI components are MainActor-isolated:

```swift
@MainActor
public struct HypenView: View { ... }

@MainActor
public class HypenRenderer: ObservableObject { ... }
```

### Sendable Conformance

Types crossing isolation boundaries use `@unchecked Sendable` for `[String: Any]`:

```swift
public struct Patch: @unchecked Sendable {
    public let props: [String: Any]?  // Non-Sendable but we ensure thread safety
}
```

### Crossing Isolation Boundaries

ActionDispatcher serializes payloads to cross MainActor boundary:

```swift
public func dispatch(action: String, payload: [String: Any]?) {
    // Serialize to Data (can cross boundaries)
    let payloadData = try? JSONSerialization.data(withJSONObject: payload)

    DispatchQueue.main.async { [weak self] in
        // Deserialize on main thread (fresh copy)
        let deserializedPayload = try? JSONSerialization.jsonObject(with: data)
        self?._engine?.dispatchAction(action, payload: deserializedPayload)
    }
}
```

### EnvironmentKey Pattern

Use `@preconcurrency` for EnvironmentKey with MainActor default:

```swift
private struct ComponentRegistryKey: @preconcurrency EnvironmentKey {
    @MainActor static let defaultValue: ComponentRegistry = ComponentRegistry.withDefaults()
}
```

## Platform Conditionals

Use `#if os()` for platform-specific code:

```swift
#if os(iOS)
.keyboardType(.emailAddress)
#endif

#if os(iOS) || os(tvOS)
Color(uiColor: .systemBackground)
#elseif os(macOS)
Color(nsColor: .windowBackgroundColor)
#else
Color.white
#endif
```

## Adding New Components

1. Create a struct conforming to `ComponentHandler`:

```swift
public struct MyComponent: ComponentHandler {
    public let typeName = "mycomponent"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Extract props
        let value = context.element.getStringProp("value.0") ?? ""

        // Handle actions
        let onTap = ActionValue.from(context.element.props["onTap.0"])

        return AnyView(
            MySwiftUIView(value: value)
                .hypenModifier(modifier)
        )
    }
}
```

2. Register in `ComponentRegistry.withDefaults()`:

```swift
public static func withDefaults() -> ComponentRegistry {
    let registry = ComponentRegistry()
    // ... existing components ...
    registry.register(MyComponent())
    return registry
}
```

## Adding New Applicators

1. Create a struct conforming to `ApplicatorHandler`:

```swift
public struct MyApplicator: ApplicatorHandler {
    public let name = "myStyle"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let stringValue = value as? String {
            // Modify the HypenModifier
            modifier.customProperty = stringValue
        }
    }
}
```

2. Add property to `HypenModifier` if needed:

```swift
public struct HypenModifier {
    // ... existing properties ...
    public var customProperty: String?
}
```

3. Apply in `hypenModifier(_:)` extension:

```swift
extension View {
    @ViewBuilder
    public func hypenModifier(_ modifier: HypenModifier) -> some View {
        self
            // ... existing modifiers ...
            .myCustomModifier(modifier.customProperty)
    }
}
```

4. Register in `ApplicatorRegistry.withDefaults()`.

## Detach/Attach Patch Handling

`PatchType.detach` / `PatchType.attach` are emitted by the engine's
Router subtree cache so navigating between routes doesn't tear down
native views. Handled in `HypenRenderer.applyDetach` / `applyAttach`
(see `Sources/HypenSwift/Render/HypenRenderer.swift`):

- **`applyDetach(id)`** — unlinks `id` from its parent's `children`
  list but keeps the `HypenElement` and its entire subtree in the
  `elements` map under the same id. No native view is freed.
- **`applyAttach(parentId, id, beforeId)`** — reinserts the still-alive
  element into a parent's children list. SwiftUI sees the same
  `HypenElement` identity, so the recursive `HypenElementView` re-emits
  views for the subtree without going through `applyCreate`.

A `Patch.remove` arriving for a detached id (engine LRU eviction)
tears down normally via `applyRemove`.

### Strategy 3 hook (limbo container)

`HypenRenderer.detachedIds: Set<String>` is exposed publicly so a
future `HypenView.swift` can render detached subtrees in a hidden
`ZStack` overlay (`.frame(0,0).opacity(0).allowsHitTesting(false)`)
keyed by NodeId. This would preserve SwiftUI `@State`, `ScrollView`
offsets, focus, and in-flight animations across the detach → attach
cycle. Not implemented today; ship if/when scroll-position loss becomes
a real complaint.

## List Virtualization (`__virt.window`)

Always on (contract: `hypen-web/docs/virtualization.md`). The engine windows
every List/Grid/lazy ForEach and sets `__virt.window` =
`{total,start,end,estimatedSize?}` on the list element. `HypenRenderer`
lifts it onto `HypenElement.virtWindow` on create/setProp (never into
`props`, so it never reaches the applicator pipeline) and clears it on
removeProp, which restores the normal container rendering.

- `Virtualization/VirtualizationMath.swift` — pure Foundation (builds and
  tests on Linux). Port of `@hypen-space/core/virtualization`
  (parseVirtWindow, childrenPerItem, windowRows, itemSize, windowPadding,
  visibleRange, wantedRange, shouldReport, windowChanged, viewportReport —
  same names and cases as the TS reference and Android's
  `virt/Virtualization.kt`), the §5 slot mapping (`Virtualization.Slots`, a
  `RandomAccessCollection` resolved on demand), the §4 `viewportMessage`,
  `anchorUnitPoint` (§2 anchoring via `scrollTo`), the accessibility strings
  (`accessibilityPosition` "Row 41 of 10000" / "Item 5 of 30",
  `accessibilitySummary` "10000 rows"), and `VirtViewportTracker`.
  `VirtualizationMathTests` mirrors `hypen-web/tests/virtualization-math.test.ts`
  case for case (plus tracker / anchoring / a11y cases) — keep aligned.
- `VirtViewportTracker` (pure) owns every decision: the visible range (best
  first: slot frames intersecting the viewport → list-edge geometry through
  the item size → `onAppear`/`onDisappear` slots), §3 step 4 (`observe` /
  `evaluate` forget `lastReported` only when `__virt.window` changes value;
  an identical re-send keeps it), and `anchorCorrection(slots, mode:)` (the
  first visible item since the last evaluation, found again by the node it
  showed — an insert/removal above moves it to another index — else by its
  index; `.contentOffset` corrects any move within the list, `.slotPosition`
  only a move to another index, since `scrollPosition(id:)` already held the
  index).
- `Virtualization/VirtualizedLazyStack.swift` — `LazyVStack` / `LazyHStack` /
  `LazyVGrid` of `total` slots. Slot identity (`ForEach` id and the
  `scrollPosition(id:)` target) is the whole-list item index `i:<index>`, so
  it does not change when a placeholder materializes; a row's content is
  keyed inside the slot by `.id("n:<nodeId>")` in a one-child stack (view
  state follows the node; the stack keeps that `.id` from standing in for the
  slot's). Placeholders are sized at the measured average. Used by List, Column, Row and
  Grid; any other windowed element (`Box`, `Stack`, unknown types) renders as
  a Column (`HypenElementContentView.componentHandler(for:)`). Evaluated once
  per main-actor turn.
  - **Geometry**: `.hypenVirtScrollContainer(axis)` (same file) gives a
    `ScrollView` a unique named coordinate space and puts
    `{space, axis, viewport extent}` in the environment. It is on the stack's
    own `ScrollView` and on the scrollable Column / Row / List / Grid
    `ScrollView`s in `LayoutComponents.swift`, so a list under an ancestor
    Hypen scroller measures against it too. Each slot and the stack report
    their frames in that space (`GeometryReader` + `onChange`); a container
    on the other axis is ignored. `onScrollGeometryChange` (iOS 18 / macOS 15)
    still feeds the owned case. Only under a host app's own `ScrollView` does
    it fall back to `onAppear`/`onDisappear` (a few slots wide).
  - **Scroll anchoring (§2)**, owned `ScrollView` only: iOS 17 / macOS 14 /
    tvOS 17 / watchOS 10 — `scrollPosition(id:anchor:)` +
    `scrollTargetLayout()` (SwiftUI keeps the first visible slot in place;
    the bound id lives in a reference box so it never re-renders the stack),
    plus `tracker.anchorCorrection(slots, mode: .slotPosition)` for an insert
    or removal above (index identity would otherwise hold the wrong item).
    Earlier — `tracker.anchorCorrection(slots, mode: .contentOffset)`. Either
    way the correction is `ScrollViewProxy.scrollTo(slotId, anchor:
    UnitPoint(…, anchorUnitPoint))`, which keeps the item's partial offset
    (rebinding the scroll position would snap it to the edge).
  - **Accessibility (§2)**: rows carry `.accessibilityHint("Row N of total")`
    (SwiftUI has no set-position API for arbitrary views; the hint reaches
    every element in the row); the stack is `.accessibilityElement(children:
    .contain)` with `.accessibilityValue("<total> rows")`. Placeholders are
    `accessibilityHidden`.
- Reports go `HypenRenderer.reportListViewport` → `viewportReporter` (wired
  in `HypenView` and the embedded app) → `RemoteEngine.setListViewport` /
  the embedded engine's `setListViewport`.
- DnD: a sortable / pinboard inside a windowed list names whole-list indices
  in its reserved writes and event locations (`HypenDndCoordinator.listIndex`).

The SwiftUI files cannot be compiled on Linux; verify on macOS/Xcode. The
pure file can: symlink it and its tests into a scratch SwiftPM package.

Known gaps:
- **Anchoring under an ancestor scroller**: no correction (a `ScrollViewProxy`
  only reaches scroll views inside its reader). Placeholders use the measured
  average, which keeps any shift small.
- **Anchoring across an insert above when the anchored item was a
  placeholder** (or left the window): nothing names it, so its index is held
  and the view shows whichever item now sits there.
- **Visible range under a host app's `ScrollView`** (not Hypen's) still comes
  from `onAppear`/`onDisappear`, a few slots wide. Harmless (a slightly larger
  window), not wrong.
- **Accessibility strings** are English, and the hint replaces a hint a row's
  own semantics set.

## Feature Parity with hypen-android

HypenSwift now has **full feature parity** with hypen-android including:

### Implemented Applicators
- **Gradients**: linearGradient, radialGradient, conicGradient, gradient
- **Background**: backgroundImage, backgroundSize, backgroundPosition
- **Transforms**: translateX, translateY, transform (compound)
- **Layout**: gap, rowGap, columnGap
- **Border**: borderStyle (solid, dashed, dotted, double - with custom drawing)
- **Visual Effects**: boxShadow, clipToBounds

### Implemented Systems
- **Router/Navigation**: Router, Route, Link, RouterController with full path matching, parameters, wildcards, and history management

### Notable Swift-Specific Implementations
- Custom StrokeStyle drawing for dashed/dotted/double borders
- AnyShapeStyle for gradient backgrounds
- SwiftUI AngularGradient for conic gradients
- NSRegularExpression for path parameter matching

## Testing

### Unit Testing Components

```swift
import XCTest
@testable import HypenSwift

class ComponentTests: XCTestCase {
    @MainActor
    func testTextComponent() {
        let element = HypenElement(
            id: "1",
            elementType: "text",
            props: ["0": "Hello World"],
            children: [],
            parentId: nil
        )

        let registry = ComponentRegistry.withDefaults()
        let handler = registry.getHandler(for: "text")

        XCTAssertNotNil(handler)
        XCTAssertEqual(handler?.typeName, "text")
    }
}
```

### Testing Action Dispatch

```swift
func testActionDispatch() {
    let mock = MockActionDispatcher()
    mock.dispatch(action: "testAction", payload: ["key": "value"])

    XCTAssertEqual(mock.dispatchedActions.count, 1)
    XCTAssertEqual(mock.dispatchedActions[0].action, "testAction")
}
```

## Reference: hypen-renderer-android

The Android implementation lives in `../hypen-renderer-android/` within this monorepo.

Key reference files:
- Components: `renderer/src/main/java/com/hypenspace/renderer/components/`
- Applicators: `renderer/src/main/java/com/hypenspace/renderer/applicators/`
- Router: `renderer/src/main/java/com/hypenspace/renderer/routing/`

## Common Issues

### Build Errors

**"Sending non-Sendable type"**
- Serialize data when crossing isolation boundaries
- Use `@unchecked Sendable` for dictionary types with proper thread safety

**"Call to main actor-isolated method in nonisolated context"**
- Add `@MainActor` annotation to the calling code
- Or dispatch to main actor: `await MainActor.run { ... }`

**"Only available in iOS X+"**
- Wrap in `#if os()` or `@available` check
- Or adjust minimum deployment target in Package.swift

### Runtime Issues

**Element not rendering**
- Check component is registered in ComponentRegistry
- Verify element type name matches exactly (case-sensitive)
- Check `visible` prop is not `false`

**Actions not dispatching**
- Verify action format is `@actions.actionName`
- Check ActionDispatcher is properly passed through context
- Ensure RemoteEngine is connected
