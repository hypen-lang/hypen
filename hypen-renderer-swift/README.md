# HypenSwift

[![Swift](https://img.shields.io/badge/Swift-6.0+-F05138?logo=swift&logoColor=white)](https://swift.org/)
[![Platforms](https://img.shields.io/badge/Platforms-iOS%20|%20macOS%20|%20tvOS%20|%20watchOS-blue)](https://developer.apple.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A SwiftUI renderer for the [Hypen](https://github.com/hypen-lang/hypen) declarative UI language. This package enables rendering Hypen UI trees natively on Apple platforms through WebSocket communication with a Hypen engine server.

> **Note:** This package lives in the main Hypen monorepo. Please open issues and PRs on the main repo: [hypen-lang/hypen](https://github.com/hypen-lang/hypen).

## Requirements

- iOS 15.0+
- macOS 12.0+
- tvOS 15.0+
- watchOS 8.0+
- Swift 6.0+

## Installation

### Swift Package Manager

Add HypenSwift to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/hypen-lang/hypen-swiftui.git", from: "0.4.42")
]
```

Then add `HypenSwift` to your target's dependencies:

```swift
.target(
    name: "YourApp",
    dependencies: [
        .product(name: "HypenSwift", package: "hypen-swiftui")
    ]
)
```

## Quick Start

### Basic Usage

```swift
import SwiftUI
import HypenSwift

struct ContentView: View {
    var body: some View {
        HypenView(url: "ws://localhost:8080/hypen")
    }
}
```

### With Configuration

```swift
import SwiftUI
import HypenSwift

struct ContentView: View {
    var body: some View {
        HypenView(
            url: "wss://your-server.com/hypen",
            config: RemoteEngineConfig(
                reconnectAttempts: 5,
                reconnectDelay: 2.0,
                enableLogging: true
            )
        )
        .onConnectionStateChange { state in
            switch state {
            case .connected:
                print("Connected to Hypen server")
            case .disconnected:
                print("Disconnected")
            case .error(let message):
                print("Error: \(message)")
            default:
                break
            }
        }
        .onError { error in
            print("Hypen error: \(error)")
        }
    }
}
```

### Custom Component Registry

You can extend HypenSwift with custom components:

```swift
import SwiftUI
import HypenSwift

// Define a custom component
struct MyCustomComponent: ComponentHandler {
    let typeName = "mycustom"

    func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let title = context.element.getStringProp("title.0") ?? "Default"

        return AnyView(
            VStack {
                Text(title)
                    .font(.headline)
                children()
            }
            .hypenModifier(modifier)
        )
    }
}

// Register and use
struct ContentView: View {
    var body: some View {
        HypenView(
            url: "ws://localhost:8080/hypen",
            componentRegistry: {
                var registry = ComponentRegistry.withDefaults()
                registry.register(MyCustomComponent())
                return registry
            }()
        )
    }
}
```

### Custom Applicator Registry

Add custom styling applicators:

```swift
import SwiftUI
import HypenSwift

// Define a custom applicator
struct GlowApplicator: ApplicatorHandler {
    let name = "glow"

    func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.shadowColor = color
            modifier.shadowRadius = 10
        }
    }
}

// Register and use
struct ContentView: View {
    var body: some View {
        HypenView(
            url: "ws://localhost:8080/hypen",
            applicatorRegistry: {
                var registry = ApplicatorRegistry.withDefaults()
                registry.register(GlowApplicator())
                return registry
            }()
        )
    }
}
```

## Architecture

### Overview

```
WebSocket Server ──► RemoteEngine ──► HypenRenderer ──► HypenView
                         │                  │
                    Patches/State      Element Tree
                         │                  │
                         ▼                  ▼
                  ActionDispatcher    ComponentRegistry
                         │            ApplicatorRegistry
                         │                  │
                         ▼                  ▼
                   @actions.*         SwiftUI Views
```

### Core Components

| Component | Purpose |
|-----------|---------|
| `HypenView` | Main entry point - connects to server and renders UI |
| `RemoteEngine` | WebSocket client handling server communication |
| `HypenRenderer` | Manages the element tree and applies patches |
| `ComponentRegistry` | Maps element types to SwiftUI component handlers |
| `ApplicatorRegistry` | Maps style properties to modifier applications |
| `HypenModifier` | Accumulates all styling for an element |

### Supported Components

| Category | Components |
|----------|------------|
| **Layout** | Column, Row, Box, Container, Center, Spacer, Stack, List, Grid |
| **Content** | Text, Heading, Paragraph, Image, Divider |
| **Interactive** | Button, Link |
| **Form** | Input, TextArea, Checkbox, Switch, Slider, Select |
| **UI** | Card, Spinner, ProgressBar, Badge, Avatar |
| **Media** | Audio, Video |
| **Router** | Router, Route |
| **Accessibility** | VisuallyHidden |

### Supported Applicators

| Category | Applicators |
|----------|-------------|
| **Spacing** | padding, margin (with directional variants) |
| **Size** | width, height, minWidth, maxWidth, minHeight, maxHeight, size, fillMaxWidth, fillMaxHeight, fillMaxSize, aspectRatio |
| **Color** | backgroundColor, background, foregroundColor, color |
| **Gradients** | linearGradient, radialGradient, conicGradient, gradient |
| **Background** | backgroundImage, backgroundSize, backgroundPosition |
| **Border** | border, borderWidth, borderColor, borderRadius, cornerRadius, borderStyle (solid, dashed, dotted, double) |
| **Layout** | alignment, weight, flex, offset, gap, rowGap, columnGap, zIndex |
| **Visual Effects** | opacity, visibility, shadow, elevation, blur, boxShadow, clipToBounds |
| **Transform** | rotate, scale, scaleX, scaleY, translateX, translateY, transform |
| **Events** | onClick, onPress, onLongClick, onLongPress |
| **Text** | fontSize, fontWeight, textAlign, lineHeight, letterSpacing, textDecoration, textTransform |

## Data Flow

### Incoming Messages

The engine receives these message types from the server:

- **initialTree** - Full element tree on connection
- **patch** - Incremental updates (create, setProp, setText, insert, move, remove)
- **stateUpdate** - State changes from the server

### Outgoing Messages

The engine sends these messages to the server:

- **dispatchAction** - User interactions (button clicks, input changes, etc.)

### Compression (`permessage-deflate`)

Compression is **not configurable from this package**, and that is a platform
constraint rather than a gap in HypenSwift. `RemoteEngineConfig` therefore has
no `compression` option, where the other Hypen client SDKs do.

`RemoteEngine` uses `URLSessionWebSocketTask`. URLSession offers
`Sec-WebSocket-Extensions: permessage-deflate` in the opening handshake by
itself and transparently inflates compressed frames when a server accepts.
Apple provides no public API to enable, disable, or parameterise this — there
is no property on the task, and the `Sec-*` handshake headers cannot be set on
the `URLRequest`.

What this means in practice:

| Server | Result |
|---|---|
| Compression-enabled Hypen server (web / Go / Kotlin / Rust) | Compressed automatically. No client changes needed. |
| `hypen-server-swift` | Uncompressed. That server declines the extension (SwiftNIO and WebSocketKit have no RFC 7692 support); negotiation is per-connection, so this is a clean fallback, not an error. |
| Any server, if you want compression *off* | Not possible from the client. Disable it server-side. |

Switching to a third-party WebSocket client (Starscream, libwebsockets) to gain
control here is explicitly out of scope for this package.

### Action Dispatch

Components dispatch actions using the `ActionDispatcher`:

```swift
// In Hypen DSL
Button(onClick: @actions.submitForm) {
    Text("Submit")
}

// The Swift renderer dispatches:
actionDispatcher.dispatch(
    action: "submitForm",
    payload: ["timestamp": Date().timeIntervalSince1970 * 1000]
)
```

## Router/Navigation

HypenSwift includes a full client-side routing system compatible with hypen-android:

### Router Component

The `Router` component manages navigation state and renders child `Route` components based on the current path:

```hypen
Router(currentPath: "/home") {
    Route(path: "/home") {
        Text("Home Page")
    }
    Route(path: "/users/:id") {
        Text("User Profile")
    }
    Route(path: "/settings/*") {
        Text("Settings Section")
    }
}
```

### Link Component

The `Link` component navigates within the router:

```hypen
Link(to: "/users/123") {
    Text("View User")
}

// With replace (no history entry)
Link(to: "/home", replace: true) {
    Text("Go Home")
}
```

### Path Matching

- **Exact match**: `/home` matches only `/home`
- **Parameters**: `/users/:id` matches `/users/123` and extracts `id: "123"`
- **Wildcards**: `/settings/*` matches `/settings`, `/settings/profile`, etc.
- **Query strings**: `/search?q=hello` extracts `query: ["q": "hello"]`

### Programmatic Navigation

Access the router controller in custom components:

```swift
@Environment(\.routerController) private var router

// Navigate
router?.push("/users/456")
router?.replace("/home")
router?.back()
router?.forward()
```

## Media Components

### Audio

Play audio files with a built-in player UI:

```hypen
Audio(src: "https://example.com/audio.mp3")

// With options
Audio(src: "https://example.com/audio.mp3", autoplay: true, loop: true)
```

**Props:**
- `src` - URL of the audio file (required)
- `autoplay` - Start playing automatically (default: false)
- `loop` - Loop playback (default: false)

### Video

Play video files with optional native controls:

```hypen
Video(src: "https://example.com/video.mp4")

// With controls and options
Video(src: "https://example.com/video.mp4", controls: true, autoplay: true, loop: true, muted: true)
```

**Props:**
- `src` - URL of the video file (required)
- `controls` - Show native playback controls (default: false)
- `autoplay` - Start playing automatically (default: false)
- `loop` - Loop playback (default: false)
- `muted` - Mute audio (default: false)

## Testing

### Mock Action Dispatcher

For testing, use `MockActionDispatcher`:

```swift
import XCTest
import HypenSwift

class MyTests: XCTestCase {
    func testButtonDispatchesAction() {
        let mockDispatcher = MockActionDispatcher()

        // ... render component with mockDispatcher ...

        // Verify dispatched actions
        XCTAssertEqual(mockDispatcher.dispatchedActions.count, 1)
        XCTAssertEqual(mockDispatcher.dispatchedActions[0].action, "buttonClicked")
    }
}
```

## Platform-Specific Behavior

### iOS
- Input components use appropriate keyboard types (email, number, phone, URL)
- Native system colors for backgrounds

### macOS
- Uses AppKit colors where appropriate
- Menu-style pickers for Select component

### tvOS/watchOS
- Basic support with SwiftUI primitives
- Some components may have limited functionality

## Known Limitations

### Platform Limitations

- `listRowSeparator` requires macOS 13+
- Some keyboard types only available on iOS
- WebSocket compression cannot be enabled, disabled, or tuned — `URLSession`
  negotiates `permessage-deflate` on its own with no public API to control it
  (see [Compression](#compression-permessage-deflate))

## Troubleshooting

### Connection Issues

```swift
HypenView(url: "ws://localhost:8080/hypen")
    .onConnectionStateChange { state in
        if case .error(let msg) = state {
            print("Connection error: \(msg)")
        }
    }
```

### Debug Logging

Raise the global log level (default: `.error`):

```swift
setLogLevel(.debug)   // or setDebugMode(true)
```

Per-connection transport logging lives on the engine config:

```swift
RemoteEngineConfig(debugLogging: true)
```

#### Routing logs into your own logger

By default Hypen writes to `NSLog`. Install a handler to send the same
messages anywhere — `os.Logger`, swift-log, analytics, an in-app console.
The SDK still does the level filtering and formatting; the handler just
receives the final tag and message:

```swift
import OSLog

let osLogger = Logger(subsystem: "com.example.app", category: "Hypen")

setLogHandler { level, tag, message in
    switch level {
    case .debug: osLogger.debug("[\(tag)] \(message)")
    case .info:  osLogger.info("[\(tag)] \(message)")
    case .warn:  osLogger.warning("[\(tag)] \(message)")
    default:     osLogger.error("[\(tag)] \(message)")
    }
}
```

Or conform a type to `HypenLogHandler` for full control:

```swift
struct MyLogHandler: HypenLogHandler {
    func debug(tag: String, message: String) { /* ... */ }
    func info(tag: String, message: String)  { /* ... */ }
    func warn(tag: String, message: String)  { /* ... */ }
    func error(tag: String, message: String) { /* ... */ }
}

setLogHandler(MyLogHandler())
setLogHandler(nil)   // back to NSLog
```

Set the handler **once at startup**, before any Hypen view starts logging —
like `setLogLevel`, it is unsynchronised global configuration.

### Element Not Rendering

1. Check the component type is registered
2. Verify the element has `visible: true` (default)
3. Check for errors in the console

## License

MIT

## Contributing

Contributions are welcome! Please open issues and PRs on the [main monorepo](https://github.com/hypen-lang/hypen).

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
