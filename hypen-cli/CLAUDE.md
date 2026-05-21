# CLAUDE.md

This file provides guidance to Claude Code when working with hypen-cli.

## Project Overview

@hypen-space/cli is the command-line tool for creating and managing Hypen applications. It provides project scaffolding, a dev server with hot reload, production builds, Hypen Studio (local IDE), and native device runners.

## Directory Structure

```
hypen-cli/
├── bin/
│   └── hypen.ts              # CLI entry point (command dispatcher)
├── src/
│   ├── index.ts              # Public API exports
│   ├── dev.ts                # Runtime-agnostic dev server wrapper
│   ├── dev-bun.ts            # Bun.serve() dev server implementation
│   ├── dev-node.ts           # Node.js http.createServer() + esbuild
│   ├── run.ts                # Android/iOS native runner
│   ├── skills.ts             # AI agent skill installation
│   ├── skill-content.ts      # Hypen DSL skill documentation
│   ├── colors.ts             # ANSI color utilities
│   └── studio/
│       └── server.ts         # Studio subprocess launcher
├── studio-ui/                # React-based IDE (see studio-ui/CLAUDE.md)
├── tests/                    # Bun test suite
│   ├── cli.test.ts           # Command tests
│   ├── dev.test.ts           # Dev server tests
│   ├── device.test.ts        # Android/iOS runner tests
│   ├── skills.test.ts        # Skill installation tests
│   └── studio.test.ts        # Studio command tests
├── build.ts                  # Bun.build() script
└── package.json
```

## Development Commands

```bash
bun test                          # Run all tests
bun run build                     # Compile TS → dist/
bun bin/hypen.ts init test-app    # Test init locally
bun bin/hypen.ts dev              # Test dev server
bun bin/hypen.ts studio           # Test Studio IDE
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `hypen init <name>` | Scaffold new project from template |
| `hypen dev` | Dev server with hot reload |
| `hypen build` | Production build |
| `hypen generate` | Generate `.hypen/components.generated.ts` |
| `hypen studio` | Launch Studio IDE |
| `hypen run android\|ios` | Run on native device/simulator |

## Architecture

### Command Flow
`bin/hypen.ts` → dispatches to handler → loads config (`hypen.json`) → executes

### Dev Server
Two implementations maintain feature parity:
- `dev-bun.ts` — Bun.serve() with WebSocket hot reload
- `dev-node.ts` — http.createServer() + esbuild fallback

Both discover components, generate entry files, and watch for changes.

### Studio
`hypen studio` spawns `studio-ui/` as a child process via `bun --hot`, passing config through environment variables (`HYPEN_PROJECT_DIR`, `HYPEN_COMPONENTS_DIR`, `HYPEN_ENTRY`, etc.).

### Native Runners (`hypen run`)
1. Starts RemoteServer (WebSocket) on port 3000
2. Discovers devices via `adb` (Android) or `xcrun simctl` (iOS)
3. Downloads & caches runner app in `~/.hypen/runners/`
4. Launches via deep link: `hypenpreview://connect?url=ws://...`
5. Streams patches over WebSocket, receives actions back

## Configuration

The CLI reads `hypen.json` (the only supported config format — `.ts` was removed to keep the loader simple and the config machine-writable for Studio):
```json
{
  "components": "./src/components",
  "entry": "App",
  "port": 3000,
  "outDir": "dist"
}
```
