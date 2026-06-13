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
    │   └── MediaComponents.swift       # Audio, Video (AVFoundation/AVKit)
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
