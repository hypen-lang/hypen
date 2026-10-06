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
- **remote/**: WebSocket client using OkHttp (see [Compression](#compression))
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

### Logging

Framework logs go to `android.util.Log` and are **error-only by default**. Raise
the level with either setter:

```kotlin
HypenLogger.setDebugMode(true)                  // DEBUG
HypenLogger.setLogLevel(HypenLogLevel.INFO)     // or a specific level
```

To send them somewhere else — Timber, Crashlytics, a file, a test recorder —
install a `HypenLogHandler`. It is a `fun interface`, so a lambda works:

```kotlin
import android.util.Log
import space.hypen.renderer.HypenLogLevel
import space.hypen.renderer.HypenLogger
import timber.log.Timber

HypenLogger.setLogLevel(HypenLogLevel.DEBUG)
HypenLogger.setLogHandler { level, tag, message, throwable ->
    val priority = when (level) {
        HypenLogLevel.DEBUG -> Log.DEBUG
        HypenLogLevel.INFO -> Log.INFO
        HypenLogLevel.WARN -> Log.WARN
        HypenLogLevel.ERROR -> Log.ERROR
        HypenLogLevel.NONE -> return@setLogHandler
    }
    Timber.tag(tag).log(priority, throwable, message)
}

// Restore the default android.util.Log output
HypenLogger.setLogHandler(null)
```

Notes:

- Messages arrive **already formatted** (varargs applied); `throwable` is
  non-null only for `error(message, throwable)` calls.
- **Level filtering stays in the SDK** — the handler is never called for a
  message below `HypenLogger.level`, and lazy `log.debug { expensive() }`
  lambdas are still skipped entirely when filtered.
- The handler is global and `@Volatile`; set it once during app startup.

## Protocol

The renderer implements the Hypen Remote UI protocol:

### Server → Client Messages

- **initialTree**: Sent on connection with initial UI tree
- **patch**: Sent when UI updates (after state changes). `module` / `state` are
  informational here: a message without them is still applied, and a message that
  cannot be parsed or handled is logged and skipped without affecting later ones.
- **stateUpdate**: Sent when state changes

### Client → Server Messages

- **dispatchAction**: Sent when user triggers an action

### Compression

WebSocket `permessage-deflate` is **on by default and requires no setup**. OkHttp
(4.3+, currently 4.12.0) advertises the extension on every upgrade handshake and
transparently inflates compressed frames, so patch batches — the large, very
compressible direction — arrive compressed automatically.

Two consequences worth knowing:

- **It cannot be disabled from the Android client.** OkHttp hardcodes the
  `Sec-WebSocket-Extensions` offer and rejects a caller-supplied one with a
  `ProtocolException`. `RemoteEngineConfig` therefore has no `compression` flag,
  since it could not be honoured. Compression is negotiated per connection: turn
  it off **server-side** (`compression: false` on the TypeScript
  `RemoteServerConfig`) when you need to read raw frames in a proxy or capture. A
  server that declines the extension just gets uncompressed frames, and the
  client falls back transparently.
- **Device access works on a compressed socket only when compression is per
  message.** The device plane (below) is enabled when the server declined the
  extension or negotiated it with BOTH `server_no_context_takeover` and
  `client_no_context_takeover` — every message compressed on its own, so device
  data never shares a compression history with other messages. That is what the
  Hypen servers negotiate. With context takeover in either direction the hello
  omits `device`, that connection runs UI-only, and one warning is logged.
- **Outbound messages under 1 KB are not compressed.** That is OkHttp's
  `minWebSocketMessageToCompress` default, which the engine leaves alone —
  client→server traffic is small hello/action JSON, where deflate framing costs
  more than it saves.

### Device capabilities (RFC 001, provisional)

Pass a `DeviceHost` (`AndroidDeviceHost.create(activity, url)`) to `HypenApp` or
`RemoteEngine` to let the server use device capabilities (gallery picker,
permissions, Bluetooth scan). Things an app has to know:

- **Admission.** A device-enabled server refuses a WebSocket upgrade without an
  `Origin` header unless its authenticator accepts it; `Origin` is a browser-only
  defence and authenticates nothing. The Android client sends **no** `Origin` by
  default and authenticates with app credentials sent as upgrade headers:

  ```kotlin
  HypenApp(
      url = "wss://app.example/ws",
      config = RemoteEngineConfig(headersProvider = { mapOf("Authorization" to "Bearer ${tokens.current()}") }),
      deviceHost = device,
  )
  ```

  `RemoteEngineConfig.origin` sends an explicit (allowlisted) `Origin` for servers
  that route by it. Header values never appear in logs or `toString()`.
- **Origin binding.** Prompts, indicators, consent grants and cooldowns use the
  origin of the URL each socket connects to, so one Application-scoped host can
  serve several servers safely.
- **Recreation.** `HypenApp` keeps its connection across Activity recreation
  (rotation, or the system destroying the Activity behind a system picker), so an
  in-flight pick still delivers its result and the server session is kept.
- **Sizes.** Picked items announce their exact size when the provider knows it;
  otherwise they are streamed without a declaration (never spooled to disk just to
  learn the size). A zero-byte item sends no frames.

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
