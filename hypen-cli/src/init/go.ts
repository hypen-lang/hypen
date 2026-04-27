/**
 * Go project generator for `hypen init`.
 *
 * Produces a minimal Hypen Go project using the `github.com/hypen-space/core`
 * SDK. Layouts are analogous to the TypeScript generator:
 *
 *   - `file-based`: `main.go` plus a `components/<Name>/<Name>.hypen`
 *     directory tree that is passed to `Source(...)` on the server.
 *   - `server-based`: `main.go` with inline DSL string constants, no
 *     `components/` directory.
 *
 * Both layouts give you a Router with two screens (`Home`, `Counter`)
 * and demonstrate typed actions + state mutation + Tailwind classes.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { dim } from "../colors.js";
import type { ModuleLayout } from "./prompts.js";

interface Options {
  projectDir: string;
  projectName: string;
  layout: ModuleLayout;
}

function write(projectDir: string, relPath: string, content: string): void {
  writeFileSync(join(projectDir, relPath), content);
  console.log(`  ${dim("Created:")} ${relPath}`);
}

function ensureDir(projectDir: string, relPath: string): void {
  mkdirSync(join(projectDir, relPath), { recursive: true });
}

function goMod(projectName: string): string {
  // Go module paths must be lowercase and cannot contain spaces.
  const modName = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `module ${modName}

go 1.21

require github.com/hypen-space/core v0.0.0
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

function hypenConfig(layout: ModuleLayout): string {
  if (layout === "server-based") {
    return `{
  "layout": "server-based",
  "entry": "main.go",
  "port": 3000
}
`;
  }
  return `{
  "layout": "file-based",
  "components": "./components",
  "entry": "App",
  "port": 3000
}
`;
}

const APP_HYPEN = `module App {
  Home()
}
.tw("flex-1 w-full min-h-screen bg-gray-50")
`;

const HOME_HYPEN = `module Home {
  Column {
    Column {
      Text("My Library")
        .tw("text-2xl md:text-3xl font-bold text-gray-900")

      Text("A starter list. Tap Save to bookmark an item.")
        .tw("text-sm md:text-base text-gray-500 mt-2")
    }
    .tw("bg-white rounded-2xl shadow-sm border border-gray-200 p-6 md:p-8")

    Column {
      ForEach(items: @state.items, key: "id") {
        Row {
          Column {
            Text("@{item.title}")
              .tw("font-semibold text-gray-900")
            Text("@{item.description}")
              .tw("text-sm text-gray-600 mt-1")
          }
          .tw("flex-1")

          If(condition: "@{item.bookmarked}") {
            Button {
              Text("Saved")
                .tw("text-green-700 font-semibold")
            }
            .tw("bg-green-50 border border-green-200 rounded-lg px-3 py-2 active:bg-green-100")
            .onClick(@actions.toggleBookmark, id: item.id)
          }

          If(condition: "@{!item.bookmarked}") {
            Button {
              Text("Save")
                .tw("text-blue-600 font-semibold")
            }
            .tw("bg-white border border-blue-200 rounded-lg px-3 py-2 active:bg-blue-50")
            .onClick(@actions.toggleBookmark, id: item.id)
          }
        }
        .tw("flex-row items-center gap-4 bg-white rounded-xl border border-gray-200 px-4 py-3")
      }
    }
    .tw("gap-3 mt-6")
  }
  .tw("flex-1 w-full max-w-2xl mx-auto p-4 md:p-8")
}
`;

function mainFileBased(projectName: string): string {
  return `// Hypen Go app (file-based layout)
//
// Modules live in \`components/<Name>/<Name>.hypen\` and are auto-discovered
// by \`Source(...)\` on the RemoteServer. This file only defines state and
// action handlers for each module.

package main

import (
\t"fmt"
\t"os"
\t"path/filepath"

\tcore "github.com/hypen-space/core"
\t"github.com/hypen-space/core/remote"
)

// loadTemplate reads \`components/<Name>/<Name>.hypen\` from disk. Go's
// \`RemoteServer\` needs the root UI string up front even when the rest
// of the components come from \`Source(...)\`.
func loadTemplate(name string) string {
\tpath := filepath.Join("components", name, name+".hypen")
\tdata, err := os.ReadFile(path)
\tif err != nil {
\t\tpanic(fmt.Sprintf("failed to read %s: %v", path, err))
\t}
\treturn string(data)
}

// ---------- App (no state) ----------

type AppState struct{}

// ---------- Home ----------

type Item struct {
\tID          string \`json:"id"\`
\tTitle       string \`json:"title"\`
\tDescription string \`json:"description"\`
\tBookmarked  bool   \`json:"bookmarked"\`
}

type HomeState struct {
\tItems []Item \`json:"items"\`
}

func seedItems() []Item {
\treturn []Item{
\t\t{ID: "1", Title: "Declarative UI",  Description: "Describe screens; Hypen handles the diffing.",       Bookmarked: false},
\t\t{ID: "2", Title: "Reactive state",  Description: "Mutate plain objects. Dependencies tracked for you.", Bookmarked: false},
\t\t{ID: "3", Title: "Cross-platform",  Description: "Same .hypen file renders on Web, iOS, and Android.",  Bookmarked: false},
\t\t{ID: "4", Title: "Typed modules",   Description: "State, actions, and UI in one typed unit.",            Bookmarked: false},
\t}
}

func main() {
\tappDef := core.NewApp(AppState{}).Name("App").Build()

\tcore.NewApp(HomeState{Items: seedItems()}).
\t\tName("Home").
\t\tOnAction("toggleBookmark", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tid, _ := payload["id"].(string)
\t\t\tif id == "" {
\t\t\t\treturn
\t\t\t}
\t\t\tfor i := range ctx.State.Items {
\t\t\t\tif ctx.State.Items[i].ID == id {
\t\t\t\t\tctx.State.Items[i].Bookmarked = !ctx.State.Items[i].Bookmarked
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t}
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

\tcore "github.com/hypen-space/core"
\t"github.com/hypen-space/core/remote"
)

type AppState struct{}

type Item struct {
\tID          string \`json:"id"\`
\tTitle       string \`json:"title"\`
\tDescription string \`json:"description"\`
\tBookmarked  bool   \`json:"bookmarked"\`
}

type HomeState struct {
\tItems []Item \`json:"items"\`
}

const appTemplate = \`${APP_HYPEN.replace(/`/g, "\\`")}\`
const homeTemplate = \`${HOME_HYPEN.replace(/`/g, "\\`")}\`

func seedItems() []Item {
\treturn []Item{
\t\t{ID: "1", Title: "Declarative UI",  Description: "Describe screens; Hypen handles the diffing.",       Bookmarked: false},
\t\t{ID: "2", Title: "Reactive state",  Description: "Mutate plain objects. Dependencies tracked for you.", Bookmarked: false},
\t\t{ID: "3", Title: "Cross-platform",  Description: "Same .hypen file renders on Web, iOS, and Android.",  Bookmarked: false},
\t\t{ID: "4", Title: "Typed modules",   Description: "State, actions, and UI in one typed unit.",            Bookmarked: false},
\t}
}

func main() {
\tappDef := core.NewApp(AppState{}).Name("App").UI(appTemplate)

\t// \`UI()\` already returns the built \`*ModuleDefinition\`, so no
\t// trailing \`.Build()\` is needed here. Naming the module via
\t// \`.Name(...)\` registers it in the shared registry.
\tcore.NewApp(HomeState{Items: seedItems()}).
\t\tName("Home").
\t\tOnAction("toggleBookmark", func(ctx core.TypedActionContext[HomeState]) {
\t\t\tpayload, _ := ctx.Action.Payload.(map[string]any)
\t\t\tid, _ := payload["id"].(string)
\t\t\tif id == "" {
\t\t\t\treturn
\t\t\t}
\t\t\tfor i := range ctx.State.Items {
\t\t\t\tif ctx.State.Items[i].ID == id {
\t\t\t\t\tctx.State.Items[i].Bookmarked = !ctx.State.Items[i].Bookmarked
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t}
\t\t}).
\t\tUI(homeTemplate)

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

function readme(projectName: string, layout: ModuleLayout): string {
  const layoutNote =
    layout === "file-based"
      ? "Modules live in `components/<Name>/<Name>.hypen`. Edit those files and restart the server."
      : "Every module and its UI template are declared inline in `main.go`.";

  return `# ${projectName}

A Hypen project scaffolded with \`hypen init\` (Go, ${layout}).

## Getting started

\`\`\`bash
go mod tidy
go run .
\`\`\`

${layoutNote}

The server is reachable at \`ws://localhost:3000\` and speaks the Hypen remote
protocol. Connect a web or native client pointed at that URL.
`;
}

/**
 * Entrypoint used by `bin/hypen.ts`.
 */
export function generateGoProject(opts: Options): void {
  const { projectDir, projectName, layout } = opts;

  write(projectDir, "go.mod", goMod(projectName));
  write(projectDir, ".gitignore", gitignore());
  write(projectDir, "hypen.json", hypenConfig(layout));
  write(projectDir, "README.md", readme(projectName, layout));

  if (layout === "file-based") {
    for (const rel of [
      "components",
      "components/App",
      "components/Home",
    ]) {
      ensureDir(projectDir, rel);
    }
    write(projectDir, "components/App/App.hypen", APP_HYPEN);
    write(projectDir, "components/Home/Home.hypen", HOME_HYPEN);
    write(projectDir, "main.go", mainFileBased(projectName));
  } else {
    write(projectDir, "main.go", mainServerBased(projectName));
  }
}
