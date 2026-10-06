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
| `hypen test` | Launch Studio directly into Test Mode; boots a RemoteServer for the entry module when run inside a project, opens in connect-only mode otherwise |
| `hypen run android\|ios` | Run on native device/simulator |

## Architecture

### Command Flow
`bin/hypen.ts` → (first-run onboarding) → dispatches to handler → loads config (`hypen.json`) → executes

### First-Run Onboarding (`src/onboarding.ts`)
On the first interactive invocation on a machine, the CLI runs a short paged
tour (Welcome → `dev` → `studio` → `test` → get started) rendered as branded
cards, advanced by keypress (`q`/Esc to skip). It runs once: a marker is
written to `~/.hypen/onboarding.json` afterwards. The tour is skipped for
non-TTY runs (CI, pipes, teleport web sessions), when `CI` or
`HYPEN_NO_ONBOARDING` is set, and after it's been seen. Set
`HYPEN_FORCE_ONBOARDING=1` to replay it.

### Init Generators (`src/init/`)
`hypen init` asks for a language (`promptLanguage`) and module layout
(`promptModuleLayout`), then dispatches to `typescript.ts` / `go.ts` /
`kotlin.ts` to scaffold a Counter starter (Router + Home + Counter). SDK
versions follow each ecosystem's "latest" so they never go stale: TS pins
`@hypen-space/*` to `"latest"` and runs `bun install`; Go ships a `go.mod`
without the hypen require and runs `go mod tidy` to pin the latest
`github.com/hypen-space/core`; Kotlin uses
`space.hypen:hypen-kotlin:latest.release`, resolved from Maven Central on
the first `./gradlew` build.

### Dev Server
Two implementations with intentionally different architectures:
- `dev-bun.ts` (primary) — runs the project through a `RemoteServer`:
  components are discovered from the filesystem, the engine renders
  server-side, and the browser loads the built-in web client at `/`
  (patches streamed over WebSocket — the same architecture `hypen test`,
  `hypen run`, and Studio previews use). Native clients can dial the same
  `ws://` port directly. Sessions are per-connection but `.syncActions()`
  replays actions across all of them, so tabs/runners mirror one scene
  (deliberate for now — drop the call for per-tab isolation).
  File watching hot-reloads all connected clients via `reload()`;
  component `.ts` modules are re-imported with mtime cache-busting.
  `htmlTemplate`/`outDir` are deprecated no-ops here (warn when passed).
- `dev-node.ts` (fallback) — the legacy browser-SPA flow:
  http.createServer() + esbuild, generates entry files, client-side WASM.
  Serves the WASM engine locally from the project's web-engine install
  when present.

`dev()` throws (`DevServerError` under Bun) on expected failures like a
missing entry component or a taken port — it never calls `process.exit`;
the CLI wrapper in `bin/hypen.ts` catches and exits.

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

Server-based projects (modules registered programmatically in the entry
script, no components directory) use a script path as `entry` — the file
extension is how `dev`/`test`/Studio detect the layout:
```json
{
  "entry": "./src/app.ts",
  "port": 3000,
  "outDir": "dist"
}
```
For these, `hypen dev` runs the entry with `bun --hot` (passing `PORT`),
`hypen build` bundles it to `<outDir>/main.js` with dependencies external,
and `hypen test`/Studio open in connect-only mode pointing at the running
server.
