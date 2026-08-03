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
 *   - `App`      root module, owns routing state and `navigate` action
 *   - `Home`     greeting screen with typed `updateGreeting` action
 *   - `Counter`  counter with typed increment/decrement/reset actions
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

function hypenConfig(layout: ModuleLayout): string {
  // File-based projects are driven by component discovery, so `entry` is a
  // component name and `components` points at the discovery root. Server-based
  // projects have no components directory at all — their modules register
  // programmatically inside the entry *script*, so `entry` is a file path
  // (the extension is how `hypen dev`/`hypen test` detect the layout).
  const config =
    layout === "server-based"
      ? {
          entry: "./src/app.ts",
          port: 3000,
          outDir: "dist",
        }
      : {
          components: "./src/components",
          entry: "App",
          port: 3000,
          outDir: "dist",
        };
  return JSON.stringify(config, null, 2) + "\n";
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
 * Root module. Holds routing state (`location`) plus a typed `navigate`
 * action dispatched from child screens. `.onAction<NavigatePayload>` gives
 * `action.payload` full TS inference inside the handler.
 */
const APP_MODULE_TS = `import { app } from "@hypen-space/core";

type AppState = {
  /** Current route path — drives the Router in the template. */
  location: string;
  /** Previous route path, used by \`navigateBack\`. */
  previousLocation: string;
};

type NavigatePayload = { to: string };

export default app
  .defineState<AppState>({
    location: "/",
    previousLocation: "/",
  })
  .onAction<NavigatePayload>("navigate", ({ action, state }) => {
    const to = action.payload?.to;
    if (!to || to === state.location) return;
    state.previousLocation = state.location;
    state.location = to;
  })
  .onAction("navigateBack", ({ state }) => {
    const back = state.previousLocation || "/";
    state.previousLocation = state.location;
    state.location = back;
  })
  .build();
`;

const APP_TEMPLATE_HYPEN = `module App {
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

/**
 * Home screen — demonstrates typed actions with a string payload and
 * dispatches the parent's \`navigate\` action to move to the counter.
 */
const HOME_MODULE_TS = `import { app } from "@hypen-space/core";

type HomeState = {
  greeting: string;
  taps: number;
};

type UpdateGreetingPayload = { greeting: string };

export default app
  .module("Home")
  .defineState<HomeState>({
    greeting: "Welcome to Hypen",
    taps: 0,
  })
  .onAction<UpdateGreetingPayload>("updateGreeting", ({ action, state }) => {
    if (action.payload?.greeting) {
      state.greeting = action.payload.greeting;
    }
  })
  .onAction("tap", ({ state }) => {
    state.taps += 1;
  })
  .build();
`;

const HOME_TEMPLATE_HYPEN = `module Home {
  Column {
    Text("@{state.greeting}")
      .tw("text-3xl font-bold text-gray-900")

    Text("You have tapped @{state.taps} time(s).")
      .tw("text-base text-gray-600 mt-2")

    Row {
      Button {
        Text("Tap me")
          .tw("text-white font-semibold")
      }
      .tw("bg-blue-600 rounded-lg px-4 py-2 active:bg-blue-700")
      .onClick(@actions.tap)

      Button {
        Text("Go to Counter →")
          .tw("text-blue-600 font-semibold")
      }
      .tw("bg-white border border-blue-600 rounded-lg px-4 py-2")
      .onClick(@actions.navigate, to: "/counter")
    }
    .tw("flex-row gap-3 mt-6")
  }
  .tw("flex-1 items-center justify-center p-8 bg-gray-50")
}
`;

/**
 * Counter screen — canonical "basic state mutation" demo plus a
 * navigation button back to Home.
 */
const COUNTER_MODULE_TS = `import { app } from "@hypen-space/core";

type CounterState = {
  count: number;
};

type StepPayload = { by: number };

export default app
  .module("Counter")
  .defineState<CounterState>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count += 1;
  })
  .onAction("decrement", ({ state }) => {
    state.count -= 1;
  })
  .onAction("reset", ({ state }) => {
    state.count = 0;
  })
  .onAction<StepPayload>("step", ({ action, state }) => {
    state.count += action.payload?.by ?? 1;
  })
  .build();
`;

const COUNTER_TEMPLATE_HYPEN = `module Counter {
  Column {
    Text("Hypen Counter")
      .tw("text-2xl font-bold text-gray-900")

    Text("@{state.count}")
      .tw("text-6xl font-bold text-blue-600 my-8")

    Row {
      Button {
        Text("-")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-red-600 rounded-lg px-6 py-3 active:bg-red-700")
      .onClick(@actions.decrement)

      Button {
        Text("Reset")
          .tw("text-white font-semibold")
      }
      .tw("bg-gray-600 rounded-lg px-6 py-3 active:bg-gray-700")
      .onClick(@actions.reset)

      Button {
        Text("+")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-green-600 rounded-lg px-6 py-3 active:bg-green-700")
      .onClick(@actions.increment)
    }
    .tw("flex-row gap-4")

    Button {
      Text("← Back to Home")
        .tw("text-blue-600 font-semibold")
    }
    .tw("mt-8 bg-transparent p-3")
    .onClick(@actions.navigate, to: "/")
  }
  .tw("flex-1 items-center justify-center p-8 bg-white gap-3")
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
    "src/components/Counter",
  ]) {
    ensureDir(projectDir, rel);
  }

  write(projectDir, "src/components/App/component.ts", APP_MODULE_TS);
  write(projectDir, "src/components/App/component.hypen", APP_TEMPLATE_HYPEN);
  write(projectDir, "src/components/Home/component.ts", HOME_MODULE_TS);
  write(projectDir, "src/components/Home/component.hypen", HOME_TEMPLATE_HYPEN);
  write(projectDir, "src/components/Counter/component.ts", COUNTER_MODULE_TS);
  write(projectDir, "src/components/Counter/component.hypen", COUNTER_TEMPLATE_HYPEN);

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
import "./components/Counter/component";

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

type AppState = {
  location: string;
  previousLocation: string;
};

type NavigatePayload = { to: string };

// Keep the DSL string as a named export so \`src/app.ts\` can pass it to
// \`RemoteServer.ui(...)\` without reaching into a built module definition.
export const AppTemplate = hypen\`module App {
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
\`;

export const AppModule = app
  .defineState<AppState>({ location: "/", previousLocation: "/" })
  .onAction<NavigatePayload>("navigate", ({ action, state }) => {
    const to = action.payload?.to;
    if (!to || to === state.location) return;
    state.previousLocation = state.location;
    state.location = to;
  })
  .onAction("navigateBack", ({ state }) => {
    const back = state.previousLocation || "/";
    state.previousLocation = state.location;
    state.location = back;
  })
  .ui(AppTemplate);
`;

  const homeModule = `import { app, hypen } from "@hypen-space/core";

type HomeState = {
  greeting: string;
  taps: number;
};

type UpdateGreetingPayload = { greeting: string };

export const HomeModule = app
  .module("Home")
  .defineState<HomeState>({ greeting: "Welcome to Hypen", taps: 0 })
  .onAction<UpdateGreetingPayload>("updateGreeting", ({ action, state }) => {
    if (action.payload?.greeting) state.greeting = action.payload.greeting;
  })
  .onAction("tap", ({ state }) => {
    state.taps += 1;
  })
  .ui(hypen\`module Home {
  Column {
    Text("@{state.greeting}")
      .tw("text-3xl font-bold text-gray-900")

    Text("You have tapped @{state.taps} time(s).")
      .tw("text-base text-gray-600 mt-2")

    Row {
      Button {
        Text("Tap me")
          .tw("text-white font-semibold")
      }
      .tw("bg-blue-600 rounded-lg px-4 py-2")
      .onClick(@actions.tap)

      Button {
        Text("Go to Counter →")
          .tw("text-blue-600 font-semibold")
      }
      .tw("bg-white border border-blue-600 rounded-lg px-4 py-2")
      .onClick(@actions.navigate, to: "/counter")
    }
    .tw("flex-row gap-3 mt-6")
  }
  .tw("flex-1 items-center justify-center p-8 bg-gray-50")
}
\`);
`;

  const counterModule = `import { app, hypen } from "@hypen-space/core";

type CounterState = { count: number };
type StepPayload = { by: number };

export const CounterModule = app
  .module("Counter")
  .defineState<CounterState>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count += 1;
  })
  .onAction("decrement", ({ state }) => {
    state.count -= 1;
  })
  .onAction("reset", ({ state }) => {
    state.count = 0;
  })
  .onAction<StepPayload>("step", ({ action, state }) => {
    state.count += action.payload?.by ?? 1;
  })
  .ui(hypen\`module Counter {
  Column {
    Text("Hypen Counter")
      .tw("text-2xl font-bold text-gray-900")

    Text("@{state.count}")
      .tw("text-6xl font-bold text-blue-600 my-8")

    Row {
      Button {
        Text("-")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-red-600 rounded-lg px-6 py-3")
      .onClick(@actions.decrement)

      Button {
        Text("Reset")
          .tw("text-white font-semibold")
      }
      .tw("bg-gray-600 rounded-lg px-6 py-3")
      .onClick(@actions.reset)

      Button {
        Text("+")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-green-600 rounded-lg px-6 py-3")
      .onClick(@actions.increment)
    }
    .tw("flex-row gap-4")

    Button {
      Text("← Back to Home")
        .tw("text-blue-600 font-semibold")
    }
    .tw("mt-8 bg-transparent p-3")
    .onClick(@actions.navigate, to: "/")
  }
  .tw("flex-1 items-center justify-center p-8 bg-white gap-3")
}
\`);
`;

  write(projectDir, "src/modules/App.ts", appModule);
  write(projectDir, "src/modules/Home.ts", homeModule);
  write(projectDir, "src/modules/Counter.ts", counterModule);

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
import "./modules/Counter";

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
