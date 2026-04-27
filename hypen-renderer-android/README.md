# Hypen Android Renderer

[![Kotlin](https://img.shields.io/badge/Kotlin-1.9+-7F52FF?logo=kotlin&logoColor=white)](https://kotlinlang.org/)
[![Jetpack Compose](https://img.shields.io/badge/Jetpack%20Compose-1.5+-4285F4?logo=jetpackcompose&logoColor=white)](https://developer.android.com/jetpack/compose)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

A Jetpack Compose renderer for Hypen UI that connects to remote Hypen servers over WebSocket.

## Overview

This project implements the Hypen Remote UI protocol for Android, allowing Android apps to render server-driven UIs using Jetpack Compose. The renderer receives patches from a Hypen server and dynamically builds the UI tree.

## Dependency

Add the renderer from Maven Central:

```kotlin
dependencies {
    implementation("space.hypen:hypen-renderer:0.4.80")
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      HypenApp Composable                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐     ┌────────────────────────────────┐   │
│  │   RemoteEngine   │────▶│        ComposeRenderer         │   │
│  │   (OkHttp WS)    │     │                                │   │
│  └──────────────────┘     │  ┌─────────────────────────┐   │   │
│          │                │  │  ComponentRegistry       │   │   │
│          │ Patches        │  │  - TextComponent        │   │   │
│          │                │  │  - ColumnComponent      │   │   │
│          ▼                │  │  - RowComponent         │   │   │
│  ┌──────────────────┐     │  │  - ButtonComponent      │   │   │
│  │  MessageParser   │     │  │  - ...                  │   │   │
│  │  (Moshi JSON)    │     │  └─────────────────────────┘   │   │
│  └──────────────────┘     │                                │   │
│                           │  ┌─────────────────────────┐   │   │
│                           │  │  ApplicatorRegistry     │   │   │
│                           │  │  - PaddingApplicator    │   │   │
│                           │  │  - ColorApplicators     │   │   │
│                           │  │  - EventApplicators     │   │   │
│                           │  │  - ...                  │   │   │
│                           │  └─────────────────────────┘   │   │
│                           └────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Modules

### renderer
The core library that can be used in any Android app:
- **model/**: Data classes for patches and messages
- **remote/**: WebSocket client using OkHttp
- **render/**: Compose renderer implementation
- **components/**: Hypen component handlers (Text, Column, Row, etc.)
- **applicators/**: Style applicators (padding, colors, events, etc.)

### app
An example Android app demonstrating the renderer usage.

### server
A sample Bun server that streams a counter UI to connected clients.

## Quick Start

### 1. Start the Server

```bash
cd server
bun install
bun run start
```

### 2. Run the Android App

Open the project in Android Studio and run the `app` module on an emulator or device.

For emulator, use `ws://10.0.2.2:3000` (default).
For physical device, use your machine's IP address.

## Usage

### Basic Usage

```kotlin
import space.hypen.renderer.HypenApp

@Composable
fun MyScreen() {
    HypenApp(
        url = "ws://10.0.2.2:3000",
        modifier = Modifier.fillMaxSize()
    )
}
```

### With Custom Configuration

```kotlin
import space.hypen.renderer.HypenApp
import space.hypen.renderer.remote.RemoteEngineConfig

@Composable
fun MyScreen() {
    HypenApp(
        url = "ws://your-server:3000",
        config = RemoteEngineConfig(
            autoReconnect = true,
            reconnectIntervalMs = 3000,
            maxReconnectAttempts = 10,
            enableLogging = BuildConfig.DEBUG
        ),
        loadingContent = { MyLoadingIndicator() },
        errorContent = { message -> MyErrorView(message) }
    )
}
```

### Using the Renderer Directly

```kotlin
val renderer = ComposeRenderer()

// Set up action dispatcher
renderer.setActionDispatcher { action, payload ->
    remoteEngine.dispatchAction(action, payload)
}

// Apply patches
remoteEngine.patches.collect { patches ->
    renderer.applyPatches(patches)
}
```

## Protocol

The renderer implements the Hypen Remote UI protocol:

### Server → Client Messages

- **initialTree**: Sent on connection with initial UI tree
- **patch**: Sent when UI updates (after state changes)
- **stateUpdate**: Sent when state changes

### Client → Server Messages

- **dispatchAction**: Sent when user triggers an action

## Supported Components

| Component | Description |
|-----------|-------------|
| Column | Vertical stack (flexbox column) |
| Row | Horizontal stack (flexbox row) |
| Text | Text content |
| Button | Clickable button |
| Container/Box | Generic container |
| Center | Centered content |
| Spacer | Empty space |
| Divider | Horizontal line |
| Image | Image (placeholder) |
| Input | Text input field |

## Supported Applicators

| Applicator | Description |
|------------|-------------|
| padding | Inner spacing |
| margin | Outer spacing |
| width/height | Dimensions |
| fillMaxWidth/Height/Size | Fill parent |
| backgroundColor | Background color |
| border/borderRadius | Borders |
| onClick/onPress | Click events |

## Extending

### Custom Components

```kotlin
class CustomComponent : ComponentHandler {
    override val typeName = "custom"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit
    ) {
        // Your custom rendering logic
    }
}

// Register
val registry = createDefaultComponentRegistry()
registry.register(CustomComponent())
```

### Custom Applicators

```kotlin
class CustomApplicator : ApplicatorHandler {
    override val name = "customStyle"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext
    ): Modifier {
        // Return modified Modifier
    }
}

// Register
val registry = createDefaultApplicatorRegistry()
registry.register(CustomApplicator())
```

## Testing

```bash
./gradlew :renderer:test
```

## Publishing (maintainers)

We use the [Vanniktech Maven Publish](https://vanniktech.github.io/gradle-maven-publish-plugin/) plugin. To release to Maven Central:

1. Export credentials:
   - `SONATYPE_USERNAME` / `SONATYPE_PASSWORD`
   - `SIGNING_KEY` (ASCII-armored PGP key), `SIGNING_PASSWORD`
2. Publish to Maven Central Portal:
   ```bash
   ./gradlew :renderer:publishAllPublicationsToMavenCentralRepository
   ```
3. For local validation:
   ```bash
   ./gradlew :renderer:publishToMavenLocal
   ```

## Dependencies

- Jetpack Compose (Material 3)
- OkHttp (WebSocket)
- Moshi (JSON parsing)
- Kotlin Coroutines

## License

MIT
