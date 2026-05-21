# Hypen Example Server

Example apps for testing the Hypen Android renderer.

## Quick Start

```bash
bun run start
# or with hot reload:
bun run dev
```

## Examples

| App | Port | Description |
|-----|------|-------------|
| Counter | 3000 | Simple counter with increment/decrement |
| Todo List | 3001 | Task list with completion states |
| Weather | 3002 | Weather display with forecast |
| Notes | 3003 | Colorful note cards |
| Calculator | 3004 | iOS-style calculator |
| Profile | 3005 | User profile with stats |

## Connecting from Android

**Emulator:**
```kotlin
HypenApp(url = "ws://10.0.2.2:3000")  // Counter
HypenApp(url = "ws://10.0.2.2:3004")  // Calculator
```

**Physical Device:**
```kotlin
HypenApp(url = "ws://YOUR_IP:3000")
```

## Custom Port

```bash
PORT=8000 bun run start
```
