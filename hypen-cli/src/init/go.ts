/**
 * Go project generator for `hypen init`.
 *
 * Produces a minimal Hypen Go project using the Go SDK, module
 * `github.com/hypen-lang/hypen/hypen-golang` (package name `core`, imported
 * as `core "github.com/hypen-lang/hypen/hypen-golang"`). Layouts are analogous to the TypeScript generator:
 *
 *   - `file-based`: `main.go` plus a `components/<Name>/component.hypen`
 *     directory tree that is passed to `Source(...)` on the server.
 *   - `server-based`: `main.go` with inline DSL string constants, no
 *     `components/` directory.
 *
 * Both layouts give you a Router with two screens (`Home`, `Counter`)
 * and demonstrate typed actions + state mutation + Tailwind classes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { dim } from "../colors.js";
import type { ModuleLayout } from "./prompts.js";

interface Options {
  projectDir: string;
  projectName: string;
  layout: ModuleLayout;
  /** SDK version to require; defaults to this CLI's own version. */
  sdkVersion?: string;
}

/** Go module path of the Hypen Go SDK (a subdirectory module of the monorepo). */
export const GO_SDK_MODULE = "github.com/hypen-lang/hypen/hypen-golang";

/**
 * The CLI and the Go SDK are versioned in lockstep (the SDK is tagged
 * `hypen-golang/vX.Y.Z` on every release), so the scaffold pins the SDK to
 * the CLI's own version.
 */
function cliVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6 && dir !== "/" && dir !== "."; i++) {
      const pkgPath = resolve(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg?.name === "@hypen-space/cli" && pkg.version) return pkg.version;
      }
      dir = dirname(dir);
    }
  } catch {}
  return "0.6.7";
}

function write(projectDir: string, relPath: string, content: string): void {
  writeFileSync(join(projectDir, relPath), content);
  console.log(`  ${dim("Created:")} ${relPath}`);
}

function ensureDir(projectDir: string, relPath: string): void {
  mkdirSync(join(projectDir, relPath), { recursive: true });
}

function goMod(projectName: string, sdkVersion: string): string {
  // Go module paths must be lowercase and cannot contain spaces.
  const modName = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  // Pinned to the SDK release matching this CLI. `go mod tidy` (run during
  // `hypen init`) fetches it and fills in go.sum and the indirect deps.
  return `module ${modName}

go 1.25.0

require ${GO_SDK_MODULE} v${sdkVersion}

// Working on the SDK itself? Point this project at a local checkout of
// github.com/hypen-lang/hypen instead of the published module, then run
// \`go mod tidy\`:
//
// replace ${GO_SDK_MODULE} => /path/to/hypen/hypen-golang
`;
}

function gitignore(): string {
  return `# Build artefacts
/bin/
/dist/
*.exe

# Go module cache
vendor/

# Environment
.env
.env.*

# IDE
.idea/
.vscode/

# OS
.DS_Store
`;
}

function hypenConfig(): string {
  return `{
  "components": "./components",
  "entry": "App",
  "port": 3000
}
`;
}

const APP_HYPEN = `module App {
  Router {
    Route(path: "/") {
      Home()
    }
    Route(path: "/counter") {
      Counter()
    }
  }
  .tw("flex-1 w-full h-full")
}
.tw("flex-1 w-full h-full bg-white")
`;

const HOME_HYPEN = `module Home {
  Column {
    Text("@{state.greeting}")
      .tw("text-3xl font-bold text-gray-900")
      .fontSize(32)
      .color("#111827")

    Text("You have tapped @{state.taps} time(s).")
      .tw("text-base text-gray-600 mt-2")
      .fontSize(16)

    Row {
      Button {
        Text("Tap me")
          .tw("text-white font-semibold")
      }
      .tw("bg-blue-600 rounded-lg px-4 py-2")
      .backgroundColor("#2563eb")
      .borderRadius(8)
      .padding(12)
      .onClick(@actions.tap)

      Button {
        Text("Go to Counter →")
          .tw("text-blue-600 font-semibold")
      }
      .tw("bg-white border border-blue-600 rounded-lg px-4 py-2")
      .borderRadius(8)
      .padding(12)
      .onClick(@router.push, to: "/counter")
    }
    .tw("flex-row gap-3 mt-6")
    .gap(12)
  }
  .tw("flex-1 w-full items-center justify-center p-8 bg-gray-50")
  .padding(32)
  .gap(8)
}
`;

const COUNTER_HYPEN = `module Counter {
  Column {
    Text("Hypen Counter")
      .tw("text-2xl font-bold text-gray-900")
      .fontSize(24)

    Text("@{state.count}")
      .tw("text-6xl font-bold text-blue-600 my-8")
      .fontSize(64)
      .color("#2563eb")
      .marginVertical(32)

    Row {
      Button {
        Text("-")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-red-600 rounded-lg px-6 py-3")
      .backgroundColor("#dc2626")
      .borderRadius(8)
      .padding(16)
      .onClick(@actions.decrement)

      Button {
        Text("Reset")
          .tw("text-white font-semibold")
      }
      .tw("bg-gray-600 rounded-lg px-6 py-3")
      .backgroundColor("#4b5563")
      .borderRadius(8)
      .padding(16)
      .onClick(@actions.reset)

      Button {
        Text("+")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-green-600 rounded-lg px-6 py-3")
      .backgroundColor("#16a34a")
      .borderRadius(8)
      .padding(16)
      .onClick(@actions.increment)
    }
    .tw("flex-row gap-4")
    .gap(16)

    Button {
      Text("← Back to Home")
        .tw("text-blue-600 font-semibold")
    }
    .tw("mt-8 bg-transparent")
    .padding(12)
    .onClick(@router.push, to: "/")
  }
  .tw("flex-1 w-full items-center justify-center p-8 bg-white")
  .padding(32)
  .gap(12)
}
`;

function mainFileBased(projectName: string): string {
  return `// Hypen Go app (file-based layout)
//
// Modules live in \`components/<Name>/component.hypen\` and are auto-discovered
// by \`Source(...)\` on the RemoteServer. This file only defines state and
// action handlers for each module.

package main

import (
\t"fmt"
\t"os"
\t"path/filepath"

\tcore "github.com/hypen-lang/hypen/hypen-golang"
\t"github.com/hypen-lang/hypen/hypen-golang/remote"
)

// loadTemplate reads \`components/<Name>/component.hypen\` from disk. Go's
// \`RemoteServer\` needs the root UI string up front even when the rest
// of the components come from \`Source(...)\`.
func loadTemplate(name string) string {
\tpath := filepath.Join("components", name, "component.hypen")
\tdata, err := os.ReadFile(path)
\tif err != nil {
\t\tpanic(fmt.Sprintf("failed to read %s: %v", path, err))
\t}
\treturn string(data)
}

// ---------- App (owns the Router) ----------

// Location is the current route path. The template's Router matches its
// Route(path: ...) children against @{state.location}, and the server keeps
// it in sync when a screen calls @router.push / @router.back, so App needs
// no navigation handlers. Don't remove it.
type AppState struct {
\tLocation string \`json:"location"\`
}

// ---------- Home ----------

type HomeState struct {
\tGreeting string \`json:"greeting"\`
\tTaps     int    \`json:"taps"\`
}

// ---------- Counter ----------

type CounterState struct {
\tCount int \`json:"count"\`
}

func main() {
\tappDef := core.NewApp(AppState{Location: "/"}).
\t\tName("App").
\t\tBuild()

\tcore.NewApp(HomeState{Greeting: "Welcome to Hypen", Taps: 0}).
\t\tName("Home").
\t\tOnAction("tap", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tctx.State.Taps++
\t\t}).
\t\tOnAction("updateGreeting", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tif g, ok := payload["greeting"].(string); ok && g != "" {
\t\t\t\tctx.State.Greeting = g
\t\t\t}
\t\t}).
\t\tBuild()

\tcore.NewApp(CounterState{Count: 0}).
\t\tName("Counter").
\t\tOnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count++
\t\t}).
\t\tOnAction("decrement", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count--
\t\t}).
\t\tOnAction("reset", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count = 0
\t\t}).
\t\tOnAction("step", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tby := 1
\t\t\tif v, ok := payload["by"].(float64); ok {
\t\t\t\tby = int(v)
\t\t\t}
\t\t\tctx.State.Count += by
\t\t}).
\t\tBuild()

\tport := 3000
\tif envPort := os.Getenv("PORT"); envPort != "" {
\t\tfmt.Sscanf(envPort, "%d", &port)
\t}

\tcomponentsDir, _ := filepath.Abs("./components")
\tserver := remote.NewRemoteServer().
\t\tSource(componentsDir).
\t\tWithDefinition(appDef).
\t\tUI(loadTemplate("App")).
\t\tConfig(remote.ServerConfig{Port: port})

\tfmt.Printf("${projectName} running on ws://localhost:%d\\n", port)
\tserver.Listen()
\tselect {}
}
`;
}

function mainServerBased(projectName: string): string {
  return `// Hypen Go app (server-based layout)
//
// Every module — state, actions and UI template — is declared inline in
// this file. No \`components/\` directory is used.

package main

import (
\t"fmt"
\t"os"

\tcore "github.com/hypen-lang/hypen/hypen-golang"
\t"github.com/hypen-lang/hypen/hypen-golang/remote"
)

// Location is the current route path. The template's Router matches its
// Route(path: ...) children against @{state.location}, and the server keeps
// it in sync when a screen calls @router.push / @router.back, so App needs
// no navigation handlers. Don't remove it.
type AppState struct {
\tLocation string \`json:"location"\`
}

type HomeState struct {
\tGreeting string \`json:"greeting"\`
\tTaps     int    \`json:"taps"\`
}

type CounterState struct {
\tCount int \`json:"count"\`
}

const appTemplate = \`${APP_HYPEN.replace(/`/g, "\\`")}\`
const homeTemplate = \`${HOME_HYPEN.replace(/`/g, "\\`")}\`
const counterTemplate = \`${COUNTER_HYPEN.replace(/`/g, "\\`")}\`

func main() {
\tappDef := core.NewApp(AppState{Location: "/"}).
\t\tName("App").
\t\tUI(appTemplate)

\t// \`UI()\` already returns the built \`*ModuleDefinition\`, so no
\t// trailing \`.Build()\` is needed here. Naming the module via
\t// \`.Name(...)\` registers it in the shared registry.
\tcore.NewApp(HomeState{Greeting: "Welcome to Hypen", Taps: 0}).
\t\tName("Home").
\t\tOnAction("tap", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tctx.State.Taps++
\t\t}).
\t\tOnAction("updateGreeting", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tif g, ok := payload["greeting"].(string); ok && g != "" {
\t\t\t\tctx.State.Greeting = g
\t\t\t}
\t\t}).
\t\tUI(homeTemplate)

\tcore.NewApp(CounterState{Count: 0}).
\t\tName("Counter").
\t\tOnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count++
\t\t}).
\t\tOnAction("decrement", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count--
\t\t}).
\t\tOnAction("reset", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tctx.State.Count = 0
\t\t}).
\t\tOnAction("step", func(ctx core.TypedActionContext[CounterState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tby := 1
\t\t\tif v, ok := payload["by"].(float64); ok {
\t\t\t\tby = int(v)
\t\t\t}
\t\t\tctx.State.Count += by
\t\t}).
\t\tUI(counterTemplate)

\tport := 3000
\tif envPort := os.Getenv("PORT"); envPort != "" {
\t\tfmt.Sscanf(envPort, "%d", &port)
\t}

\tserver := remote.NewRemoteServer().
\t\tWithDefinition(appDef).
\t\tUI(appTemplate).
\t\tConfig(remote.ServerConfig{Port: port})

\tfmt.Printf("${projectName} running on ws://localhost:%d\\n", port)
\tserver.Listen()
\tselect {}
}
`;
}

function readme(projectName: string, layout: ModuleLayout, sdkVersion: string): string {
  const layoutNote =
    layout === "file-based"
      ? "Modules live in `components/<Name>/component.hypen`. Edit those files and restart the server."
      : "Every module and its UI template are declared inline in `main.go`.";

  return `# ${projectName}

A Hypen project scaffolded with \`hypen init\` (Go, ${layout}).

## Getting started

Requires Go 1.25 or newer (the Hypen Go SDK's minimum).

\`\`\`bash
go mod tidy
go run .
\`\`\`

${layoutNote}

The server is reachable at \`ws://localhost:3000\` and speaks the Hypen remote
protocol. Connect a web or native client pointed at that URL.

## The Hypen Go SDK

The project depends on \`${GO_SDK_MODULE}\` v${sdkVersion} (the version of
the \`hypen\` CLI that generated it). The package is named \`core\`, so it is
imported as:

\`\`\`go
import (
\tcore "${GO_SDK_MODULE}"
\t"${GO_SDK_MODULE}/remote"
)
\`\`\`

To upgrade: \`go get ${GO_SDK_MODULE}@latest\`.

To build against a local checkout of the SDK instead (SDK contributors),
uncomment the \`replace\` line at the bottom of \`go.mod\`, point it at your
\`hypen/hypen-golang\` directory and run \`go mod tidy\`.
`;
}

/**
 * Entrypoint used by `bin/hypen.ts`.
 */
export function generateGoProject(opts: Options): void {
  const { projectDir, projectName, layout } = opts;
  const sdkVersion = (opts.sdkVersion ?? cliVersion()).replace(/^v/, "");

  write(projectDir, "go.mod", goMod(projectName, sdkVersion));
  write(projectDir, ".gitignore", gitignore());
  write(projectDir, "hypen.json", hypenConfig());
  write(projectDir, "README.md", readme(projectName, layout, sdkVersion));

  if (layout === "file-based") {
    for (const rel of [
      "components",
      "components/App",
      "components/Home",
      "components/Counter",
    ]) {
      ensureDir(projectDir, rel);
    }
    write(projectDir, "components/App/component.hypen", APP_HYPEN);
    write(projectDir, "components/Home/component.hypen", HOME_HYPEN);
    write(projectDir, "components/Counter/component.hypen", COUNTER_HYPEN);
    write(projectDir, "main.go", mainFileBased(projectName));
  } else {
    write(projectDir, "main.go", mainServerBased(projectName));
  }
}
