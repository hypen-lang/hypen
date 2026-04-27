/**
 * TypeScript project generators for `hypen init`.
 *
 * Produces two layouts from the same set of modules:
 *
 *   - `file-based`: each module lives in its own folder under
 *     `src/components/<Name>/` with separate `component.ts` (logic) and
 *     `component.hypen` (template). Modules are auto-discovered by
 *     `serve({ source })` at startup.
 *
 *   - `server-based`: all modules are defined inline in `src/app.ts`
 *     using the `hypen` tagged template literal for their UI, then
 *     registered programmatically with `RemoteServer`. No `.hypen`
 *     files are written.
 *
 * Both layouts share the same demo surface:
 *   - `App`   minimal root module that mounts `Home`
 *   - `Home`  list of items with a typed `toggleBookmark` action
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { dim } from "../colors.js";
import type { ModuleLayout } from "./prompts.js";

const DEP_VERSION = "latest";

/**
 * Version used for the `@hypen-space/*` dependencies in every generated
 * `package.json`. Exported so `bin/hypen.ts` can reuse the same value
 * when patching up a project post-teleport without duplicating the
 * stopgap comment below.
 *
 * **Stopgap**: the local CLI `VERSION` has outrun what's published to
 * npm. Using `^${VERSION}` emits a constraint the registry can't
 * resolve, so every freshly scaffolded project's `bun install` fails.
 * Pinning to `"latest"` unblocks new users immediately. Revert once
 * the publish flow catches up.
 */
export const TS_DEP_VERSION = DEP_VERSION;

/**
 * Shape of the `package.json` written by the TypeScript generator.
 * Exported so it can be used by repair flows (e.g. `ensureProjectDeps`
 * after a teleport) instead of hand-maintaining a parallel copy.
 */
export function buildTsPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "hypen dev",
        build: "hypen build",
        start: "node dist/main.js",
      },
      dependencies: {
        "@hypen-space/core": DEP_VERSION,
        "@hypen-space/server": DEP_VERSION,
        "@hypen-space/web": DEP_VERSION,
        "@hypen-space/web-engine": DEP_VERSION,
      },
      devDependencies: {
        "@hypen-space/cli": DEP_VERSION,
        "@types/bun": "latest",
        esbuild: "^0.20.0",
        typescript: "^5.0.0",
      },
    },
    null,
    2,
  );
}

interface Options {
  projectDir: string;
  projectName: string;
  layout: ModuleLayout;
}

function write(projectDir: string, relPath: string, content: string): void {
  const full = join(projectDir, relPath);
  writeFileSync(full, content);
  console.log(`  ${dim("Created:")} ${relPath}`);
}

function ensureDir(projectDir: string, relPath: string): void {
  const full = join(projectDir, relPath);
  mkdirSync(full, { recursive: true });
}

function packageJson(name: string): string {
  return buildTsPackageJson(name);
}

function tsconfigJson(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["src/**/*"],
    },
    null,
    2,
  );
}

/**
 * `file-based` projects scan a folder of .hypen files; `server-based`
 * projects boot a single TS entry script and register modules inline.
 * The CLI reads `layout` to dispatch `hypen dev` correctly.
 */
function hypenConfig(layout: ModuleLayout = "file-based"): string {
  if (layout === "server-based") {
    return JSON.stringify(
      {
        layout: "server-based",
        entry: "src/app.ts",
        port: 3000,
        outDir: "dist",
      },
      null,
      2,
    ) + "\n";
  }
  return JSON.stringify(
    {
      layout: "file-based",
      components: "./src/components",
      entry: "App",
      port: 3000,
      outDir: "dist",
    },
    null,
    2,
  ) + "\n";
}

function gitignore(): string {
  return `# Dependencies
node_modules/

# Build output
dist/
.hypen/

# AI agent skills
.claude/skills/
.agent/skills/

# Environment
.env
.env.*
!.env.example
.npmrc

# IDE
.idea/
.vscode/

# OS
.DS_Store
Thumbs.db

# Logs
*.log
`;
}

// ---------------------------------------------------------------------------
// Module sources (shared between file-based and server-based layouts)
// ---------------------------------------------------------------------------

/**
 * Root module — minimal shell. The scaffold is intentionally a single
 * screen so you can clone, run, and start hacking without unpacking a
 * router and a navigation state machine first.
 */
const APP_MODULE_TS = `import { app } from "@hypen-space/core";

export default app
  .defineState({})
  .build();
`;

const APP_TEMPLATE_HYPEN = `module App {
  Home()
}
.tw("flex-1 w-full min-h-screen bg-gray-50")
`;

/**
 * Home screen — demonstrates typed actions with a string payload and
 * dispatches a typed action to toggle a bookmark on a list item.
 */
const HOME_MODULE_TS = `import { app } from "@hypen-space/core";

type Item = {
  id: string;
  title: string;
  description: string;
  bookmarked: boolean;
};

type HomeState = {
  items: Item[];
};

type ToggleBookmarkPayload = { id: string };

export default app
  .module("Home")
  .defineState<HomeState>({
    items: [
      { id: "1", title: "Declarative UI",  description: "Describe screens; Hypen handles the diffing.",       bookmarked: false },
      { id: "2", title: "Reactive state",  description: "Mutate plain objects. Dependencies tracked for you.", bookmarked: false },
      { id: "3", title: "Cross-platform",  description: "Same .hypen file renders on Web, iOS, and Android.",  bookmarked: false },
      { id: "4", title: "Typed modules",   description: "State, actions, and UI in one typed unit.",            bookmarked: false },
    ],
  })
  .onAction<ToggleBookmarkPayload>("toggleBookmark", ({ action, state }) => {
    const id = action.payload?.id;
    if (!id) return;
    const item = state.items.find((it) => it.id === id);
    if (item) item.bookmarked = !item.bookmarked;
  })
  .build();
`;

const HOME_TEMPLATE_HYPEN = `module Home {
  Column {
    // ── Header card ─────────────────────────────────────────
    Column {
      Text("My Library")
        .tw("text-2xl md:text-3xl font-bold text-gray-900")

      Text("A starter list. Tap Save to bookmark an item.")
        .tw("text-sm md:text-base text-gray-500 mt-2")
    }
    .tw("bg-white rounded-2xl shadow-sm border border-gray-200 p-6 md:p-8")

    // ── Item list ───────────────────────────────────────────
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

// ---------------------------------------------------------------------------
// Layout A: file-based
// ---------------------------------------------------------------------------

function generateFileBased(opts: Options): void {
  const { projectDir } = opts;

  for (const rel of [
    "src",
    "src/components",
    "src/components/App",
    "src/components/Home",
  ]) {
    ensureDir(projectDir, rel);
  }

  write(projectDir, "src/components/App/component.ts", APP_MODULE_TS);
  write(projectDir, "src/components/App/component.hypen", APP_TEMPLATE_HYPEN);
  write(projectDir, "src/components/Home/component.ts", HOME_MODULE_TS);
  write(projectDir, "src/components/Home/component.hypen", HOME_TEMPLATE_HYPEN);

  const appEntry = `/**
 * Hypen application entry point (file-based layout).
 *
 * Modules and their \`.hypen\` templates are discovered from
 * \`src/components/*\` by \`serve({ source })\`.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { serve } from "@hypen-space/server/remote";
import App from "./components/App/component";

// Ensure child modules register with the shared \`app\` registry before
// the server walks it.
import "./components/Home/component";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(__dirname, "./components");

const server = await serve({
  module: App,
  moduleName: "App",
  source: componentsDir,
  port: Number(process.env.PORT) || 3000,
});

console.log(\`Server running at \${server.url}\`);
`;
  write(projectDir, "src/app.ts", appEntry);
}

// ---------------------------------------------------------------------------
// Layout B: server-based
// ---------------------------------------------------------------------------

/**
 * The server-based layout uses the `hypen` tagged template literal for
 * inline UI, and `app.module("Name").defineState(...).ui(hypen`...`)`
 * to auto-register each module in the shared `app` registry. A single
 * `src/app.ts` wires everything up through `RemoteServer`.
 */
function generateServerBased(opts: Options): void {
  const { projectDir } = opts;

  for (const rel of ["src", "src/modules"]) {
    ensureDir(projectDir, rel);
  }

  const appModule = `import { app, hypen } from "@hypen-space/core";

// Keep the DSL string as a named export so \`src/app.ts\` can pass it to
// \`RemoteServer.ui(...)\` without reaching into a built module definition.
export const AppTemplate = hypen\`module App {
  Home()
}
.tw("flex-1 w-full min-h-screen bg-gray-50")
\`;

export const AppModule = app
  .defineState({})
  .ui(AppTemplate);
`;

  const homeModule = `import { app, hypen } from "@hypen-space/core";

type Item = {
  id: string;
  title: string;
  description: string;
  bookmarked: boolean;
};

type HomeState = { items: Item[] };
type ToggleBookmarkPayload = { id: string };

export const HomeModule = app
  .module("Home")
  .defineState<HomeState>({
    items: [
      { id: "1", title: "Declarative UI",  description: "Describe screens; Hypen handles the diffing.",       bookmarked: false },
      { id: "2", title: "Reactive state",  description: "Mutate plain objects. Dependencies tracked for you.", bookmarked: false },
      { id: "3", title: "Cross-platform",  description: "Same .hypen file renders on Web, iOS, and Android.",  bookmarked: false },
      { id: "4", title: "Typed modules",   description: "State, actions, and UI in one typed unit.",            bookmarked: false },
    ],
  })
  .onAction<ToggleBookmarkPayload>("toggleBookmark", ({ action, state }) => {
    const id = action.payload?.id;
    if (!id) return;
    const item = state.items.find((it) => it.id === id);
    if (item) item.bookmarked = !item.bookmarked;
  })
  .ui(hypen\`module Home {
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
\`);
`;

  write(projectDir, "src/modules/App.ts", appModule);
  write(projectDir, "src/modules/Home.ts", homeModule);

  const appEntry = `/**
 * Hypen application entry point (server-based layout).
 *
 * Every module is registered programmatically with \`RemoteServer\`. The
 * \`hypen\` tagged template inside each module carries its own UI, so no
 * \`.hypen\` files are required for this layout.
 */

import { app } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server/remote";

import { AppModule, AppTemplate } from "./modules/App";
// Importing for side effects: each module self-registers in the shared
// \`app\` registry so \`.app(app)\` below can hand them to the server.
import "./modules/Home";

const port = Number(process.env.PORT) || 3000;

const server = await new RemoteServer()
  .app(app)
  .module("App", AppModule)
  .ui(AppTemplate)
  .config({ port })
  .listen();

console.log(\`Server running at \${server.url}\`);
`;
  write(projectDir, "src/app.ts", appEntry);
}

/**
 * Entrypoint used by `bin/hypen.ts`. Writes all files for the chosen
 * layout into `projectDir` and prints creation logs to stdout.
 */
export function generateTypescriptProject(opts: Options): void {
  const { projectDir, projectName, layout } = opts;

  write(projectDir, "package.json", packageJson(projectName));
  write(projectDir, "hypen.json", hypenConfig(layout));
  write(projectDir, "tsconfig.json", tsconfigJson());
  write(projectDir, ".gitignore", gitignore());

  if (layout === "file-based") {
    generateFileBased(opts);
  } else {
    generateServerBased(opts);
  }
}
