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
│   ├── dev-node.ts           # Node.js dev server (RemoteServer on node:http)
│   ├── node-ws.ts            # Minimal RFC 6455 server for dev-node
│   ├── build-wasm.ts         # `hypen build --target wasm`: public entry, re-exports src/wasm/
│   ├── build-error.ts        # BuildError (code/module/file/field/tool/hint) + formatBuildError
│   ├── wasm/                 # The wasm build (see "Wasm Build" below)
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
│   ├── studio.test.ts        # Studio command tests
│   └── wit-sync.test.ts      # vendored WIT == canonical (scripts/sync-wit.sh --check)
├── wit/, wit-v0_2/           # GENERATED from /wit, /wit-v0_2 by scripts/sync-wit.sh — do not edit
├── wit-tinygo/               # /wit + TinyGo-owned `tinygo-module` world & WASI deps (see its README.md)
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
| `hypen build` | Production build (browser SPA) |
| `hypen build --target wasm` | Portable build: per-module `.wasm` components + `.hypen` UI + `app.json`, runnable offline via `hypen-runtime --app` |
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
`kotlin.ts` to scaffold a Counter starter (Router + Home + Counter). TS and
Kotlin pin the SDK to the CLI's own version (TS: `^<version>` for
`@hypen-space/*`, then `bun install`; Kotlin: `space.hypen:hypen-kotlin:<version>`
from Maven Central, whose jar bundles the native engine; contributors can
build the SDK from a checkout via `HYPEN_KOTLIN_SDK` and override the engine
with `HYPEN_NATIVE_LIB_DIR`). Go's `go.mod` requires
`github.com/hypen-lang/hypen/hypen-golang v<version>` (with a commented
`replace` for SDK contributors), then runs `go mod tidy`.

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
- `dev-node.ts` (Node fallback) — the same RemoteServer architecture:
  `RemoteServer.prepare()` + `createSession()` behind `node:http` and the
  minimal RFC 6455 server in `node-ws.ts` (`listen()` is `Bun.serve`, and
  the CLI carries no `ws` dependency). Same routes as `listen()`: web
  client at `/` + `/__hypen__/client.js` (the bundle shipped in
  `@hypen-space/server`), SPA fallback for app-route navigations,
  `/__hypen__/health`, `/health`, `/stats`; hot reload via `reload()`.
  Packages resolve from the project (`dev-resolve.ts`, `createRequire`
  under Node). Needs Node TypeScript type stripping (>= 22.18) to import
  `component.ts`; otherwise throws `DevServerError("UNSUPPORTED_RUNTIME")`
  telling the user to use Bun.

`dev()` throws `DevServerError` (both runtimes) on expected failures like a
missing entry component or a taken port — it never calls `process.exit`;
the CLI wrapper in `bin/hypen.ts` catches and exits.

### Wasm Build (`src/wasm/`, entry `src/build-wasm.ts`)
`buildWasm({ root, components, entry, outDir, wasm })` throws `BuildError`
and never exits. Layout, one responsibility per file:

| File | Responsibility |
|------|----------------|
| `build.ts` | Orchestrator: config → language → output safety → discovery → capabilities → prepare → compile → manifest → publish |
| `types.ts` | Vocabulary: `Language`, `Abi`, branded `ModuleName` / `ScopeName`, `StatefulModule<S>` / `StatelessComponent`, `Capabilities` |
| `config.ts` | `parseWasmConfig` (raw hypen.json `wasm` → normalised `WasmConfig`), `resolveModuleCapabilities` |
| `discover.ts` | Language detection, component-dir scan, `assertBuildable` (names, collisions, entry) |
| `builders/{builder,ts,go,rust}.ts` | `ModuleBuilder<S, P>`: `discover` → `prepare` (toolchain + setup) → `build` |
| `toolchain.ts` | jco / tinygo / cargo lookups as `ToolLookup` (found / missing / outdated + install hint) |
| `process.ts` | `runTool` → `ToolRun`; `expectSuccess` → `TOOL_FAILED` with command, exit code, stderr tail |
| `wit.ts` | TS per-module world (`tsBuildWorld`), Rust `wit/` provisioning |
| `assets.ts` | Locates bundled WIT dirs and shims from `src/`, `dist/src/`, `dist/bin/` |
| `artifact.ts` | Checks an output is a wasm *Component* (magic + layer bytes) |
| `manifest.ts` | `app.json` types and serialisation |
| `output.ts` | Private work dir, atomic publish into `<outDir>/wasm`, cleanup |
| `node-stubs.ts` | esbuild plugin stubbing Node built-ins for the TS bundle |
| `shims/module-shim.ts` | The TS shim (module definition → `hypen:module` exports). Runs *inside the guest*: no imports, no Node/Bun APIs. Type-checked by tsc, unit-tested in `tests/wasm-shims.test.ts` |
| `shims/module_shim.go` | The Go shim template; a gofmt-valid file whose three `hypen.invalid/...` imports `renderGoShim` replaces |

`build.ts` (the package build) compiles `module-shim.ts` to
`dist/src/wasm/shims/module-shim.js` and copies `module_shim.go` beside it;
both are read from disk at run time, not bundled into the CLI.

`wasm` is the raw hypen.json section: `language` (`ts`/`go`/`rust`, overrides
Cargo.toml/go.mod detection; required when both exist) and
`modules.<Name>.{reads,dispatches,storage,http}` capability grants, emitted
explicitly on every stateful `app.json` entry (defaults
`[]`/`[]`/`[]`/`false`; the host is deny-by-default). A `modules.<Name>`
entry with `component` (path to a `.wasm`) and optionally `template` declares a
**prebuilt** module (`ModuleGrants.prebuilt`; `wasm/prebuilt.ts` resolves and
validates the files → `PrebuiltModule`): the wasm build copies it into the
output and lists it in `app.json` (`placePrebuilt` in `wasm/build.ts`: a
same-named source module is `MODULE_NAME_COLLISION`, a same-named
template-only component donates its template, no toolchain is looked up when
every stateful module is prebuilt, and discovery's `assertNoForeignModule`
skips declared names via `Project.prebuilt`); `hypen dev` loads it into the
RemoteServer as a hosted module (`dev-hosted.ts`: `DevPrebuiltModules`
attaches, prints `HostedModuleFailure`s, watches the files' directories and
hypen.json, and calls `RemoteServer.reloadWasmModule`); the SPA build throws
`PREBUILT_UNSUPPORTED_TARGET`; a server-based build copies the files under
`outDir` (`copyPrebuiltModules`). TS modules are
componentized with the pinned `@bytecodealliance/jco` (optional peer + dev
dependency; a project-local `node_modules/.bin/jco` overrides it) against a
per-module world carrying only the granted storage imports. Rust artifacts
come from `cargo --message-format=json`; a CLI-provisioned crate `wit/`
(marked `.hypen-provisioned`) is refreshed when it differs from the WIT for
the crate's ABI.

Errors: every user-fixable failure is a `BuildError` with a stable `code`
(`BuildErrorCode` in `src/build-error.ts`), the `module` / `file` / `field` it
concerns, `tool` (command, exit code, stderr tail) when a subprocess failed,
and a `hint`. `bin/hypen.ts` prints them with `formatBuildError`. New failure
modes get a code and a hint, not a bare message.

Tests: `tests/build-wasm.test.ts` (units + E2E:
`HYPEN_WASM_E2E=1 bun test tests/build-wasm.test.ts`),
`tests/wasm-shims.test.ts`, `tests/wasm-errors.test.ts` (bad paths, driven by
fake toolchain scripts — no real toolchain needed).

### Studio
`hypen studio` spawns `studio-ui/` as a child process via `bun --hot`, passing config through environment variables (`HYPEN_PROJECT_DIR`, `HYPEN_COMPONENTS_DIR`, `HYPEN_ENTRY`, etc.).

The editor Preview streams from the studio-hosted RemoteServer
(`/ws/engine`, `studio-ui/src/server/engine-host.ts`) — the same engine Test
Mode cells use — so entry + nested module handlers and `@router.*` all run
for real; edits reach it via autosave + the components watcher. It falls
back to an in-browser, layout-only render only when `/api/engine/status`
reports `unavailable` (no entry yet, etc.). The phone frame lays the app out
at a device's logical size (393x852) and scales it down.

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
