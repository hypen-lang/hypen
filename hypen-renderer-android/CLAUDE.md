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
```

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

### Strategy 3 hook (limbo container)

`ComposeRenderer.getDetachedIds(): List<String>` is exposed so a
future `HypenApp.kt` root composable can render detached subtrees in
a hidden `Box` overlay (`Modifier.size(0.dp).alpha(0f)`) keyed by
`key(id) { ... }`. This would preserve `remember`,
`rememberScrollState` / `rememberLazyListState`, focus, and
animations across the detach → attach cycle. Not implemented today;
ship if/when scroll-position loss becomes a real complaint.

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
