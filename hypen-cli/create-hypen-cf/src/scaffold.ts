/**
 * Pure scaffold generator for a Hypen-on-Cloudflare app.
 *
 * `scaffold(opts)` returns a path→content map; the CLI (`bin/create-hypen-cf.ts`)
 * writes it to disk. Keeping generation pure makes the emitted files unit-
 * testable without a filesystem.
 *
 * The output is a MINIMAL single-module app: worker + DO subclass + engine
 * binding + one App component, no database. It mirrors the proven shapes from
 * `examples/calorie-counter/cloudflare` (the v2 HypenDurableObject + injected
 * CFEngine), minus the bun:sqlite shim — adding storage is an opt-in step the
 * generated README points to.
 */

export interface ScaffoldOptions {
  /** Project / wrangler worker name, e.g. "my-app". Used as the dir + worker name. */
  appName: string;
  /** Primary module name (PascalCase), e.g. "App". Also the protocol module name. */
  moduleName?: string;
  /**
   * Dependency specifiers for the Hypen packages. Defaults to the published
   * npm names; the examples in this repo override with `file:` links.
   */
  deps?: {
    core?: string;
    cf?: string;
    engine?: string;
  };
}

export interface ResolvedOptions {
  appName: string;
  moduleName: string;
  doClass: string;
  doBinding: string;
  deps: { core: string; cf: string; engine: string };
}

/** kebab/space/underscore → PascalCase. */
export function toPascalCase(s: string): string {
  return s
    .replace(/[-_\s]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** A name → SCREAMING_SNAKE_CASE binding (e.g. "App" → "APP_DO"). */
export function toBinding(moduleName: string): string {
  const snake = moduleName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();
  return `${snake}_DO`;
}

/** Validate + fill defaults. Throws on an unusable appName. */
export function resolveOptions(opts: ScaffoldOptions): ResolvedOptions {
  const appName = opts.appName?.trim();
  if (!appName || !/^[a-z0-9][a-z0-9-]*$/.test(appName)) {
    throw new Error(
      `Invalid app name "${opts.appName}". Use lowercase letters, digits, and hyphens (e.g. "my-app").`,
    );
  }
  const moduleName = toPascalCase(opts.moduleName ?? "App") || "App";
  return {
    appName,
    moduleName,
    doClass: `${moduleName}DO`,
    doBinding: toBinding(moduleName),
    deps: {
      core: opts.deps?.core ?? "@hypen-space/core@latest",
      cf: opts.deps?.cf ?? "@hypen-space/cf@latest",
      engine: opts.deps?.engine ?? "hypen-engine@latest",
    },
  };
}

function packageJson(o: ResolvedOptions): string {
  return (
    JSON.stringify(
      {
        name: o.appName,
        type: "module",
        private: true,
        scripts: {
          dev: "wrangler dev",
          deploy: "wrangler deploy",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          "@hypen-space/core": o.deps.core,
          "@hypen-space/cf": o.deps.cf,
          "hypen-engine": o.deps.engine,
        },
        devDependencies: {
          "@cloudflare/workers-types": "^4.20250101.0",
          typescript: "^5.6.0",
          wrangler: "^4.0.0",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function wranglerJsonc(o: ResolvedOptions): string {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${o.appName}",
  "main": "src/worker.ts",
  "compatibility_date": "2025-05-01",
  // web_socket_compression lets workerd negotiate permessage-deflate on the
  // DO's WebSocketPair — without the flag it always serves uncompressed frames.
  "compatibility_flags": ["nodejs_compat", "web_socket_compression"],

  // The Hypen WASM engine is pulled in as a CompiledWasm module. This rule is
  // what makes the engine boot inside a Worker (workerd hands you a
  // WebAssembly.Module, which the web-target glue instantiates via initSync).
  "rules": [
    { "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": false }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "${o.doBinding}", "class_name": "${o.doClass}" }
    ]
  },

  // new_sqlite_classes opts the DO into synchronous SQLite storage
  // (state.storage.sql). You only need it if you add a database; it's harmless
  // to keep for the persisted-state store this starter uses.
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["${o.doClass}"] }
  ]
}
`;
}

function tsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
`;
}

function workerTs(o: ResolvedOptions): string {
  return `/**
 * Worker entrypoint — forwards every WebSocket upgrade to a single Durable
 * Object instance keyed by ?sessionId= (or a fresh UUID). One DO == one
 * Hypen session.
 */

export { ${o.doClass} } from "./do";

interface Env {
  ${o.doBinding}: DurableObjectNamespace;
}

function routingKey(request: Request): string {
  const url = new URL(request.url);
  const sid = url.searchParams.get("sessionId");
  if (sid) return sid;
  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const m = cookie.match(/hypen_session=([^;]+)/);
    if (m) return m[1]!;
  }
  return crypto.randomUUID();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
      const id = env.${o.doBinding}.idFromName(routingKey(request));
      return env.${o.doBinding}.get(id).fetch(request);
    }
    return new Response(
      "${o.appName} (Hypen on Cloudflare). Connect a Hypen client to ws://<host>/ws.\\n",
      { headers: { "content-type": "text/plain" } },
    );
  },
};

// CF type stubs — shadowed at runtime by wrangler's real types.
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}
interface DurableObjectId {}
`;
}

function doTs(o: ResolvedOptions): string {
  return `/**
 * ${o.doClass} — the Durable Object hosting this Hypen app.
 *
 * A thin subclass of @hypen-space/cf's HypenDurableObject (which hosts a core
 * RemoteSession and owns the whole remote protocol). You declare two things:
 *
 *   - getConfig()    — the primary module + its template.
 *   - createEngine() — the CFEngine bound to the WASM (see ./engine).
 *
 * Add nested modules by passing \`app\` + \`componentTemplates\` in getConfig();
 * see the calorie-counter / social examples in the Hypen repo.
 */

import { HypenDurableObject, type HypenDurableObjectConfig } from "@hypen-space/cf";
import type { BaseEngine } from "@hypen-space/core/engine-base";

import { CFEngine } from "./engine";
import ${o.moduleName.toLowerCase()}Module from "./components/${o.moduleName}";

export class ${o.doClass} extends HypenDurableObject {
  getConfig(): HypenDurableObjectConfig {
    return {
      module: ${o.moduleName.toLowerCase()}Module,
      template: ${o.moduleName.toLowerCase()}Module.template ?? "",
      moduleName: "${o.moduleName}",
      // wrangler.jsonc enables the web_socket_compression flag; declaring it
      // lets the DO check each socket's negotiated compression before
      // allowing device traffic on it.
      webSocketCompression: true,
    };
  }

  createEngine(): BaseEngine {
    return new CFEngine();
  }
}
`;
}

function engineTs(): string {
  return `/**
 * CFEngine for this worker — a thin binding over @hypen-space/cf's
 * createCFEngine. The two imports below resolve only under wrangler's bundler
 * (CompiledWasm + the web-target glue), which is why the package can't make
 * them itself. See hypen-web/docs/implementing-an-engine.md.
 */

import { createCFEngine } from "@hypen-space/cf";
// @ts-ignore — wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore — the web-target glue; initSync(module) accepts a compiled module.
import * as wasm from "hypen-engine";

export const CFEngine = createCFEngine(wasm as never, wasmModule as WebAssembly.Module);
`;
}

function appComponentTs(o: ResolvedOptions): string {
  return `import { app } from "@hypen-space/core";

// The primary module. State mutations auto-propagate; \`@actions.*\` route to
// the onAction handlers; the UI is the inline Hypen DSL template below.
export default app
  .defineState<{ count: number }>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count += 1;
  })
  .ui(\`
    module ${o.moduleName} {
      Column {
        Text("${o.moduleName} — count: @{state.count}")
          .tw("text-xl font-bold p-4")
        Button("@actions.increment") {
          Text("Increment")
        }
          .tw("bg-blue-500 text-white rounded px-4 py-2 m-4")
      }
      .tw("flex-1 items-center justify-center min-h-screen bg-white")
    }
  \`);
`;
}

function readmeMd(o: ResolvedOptions): string {
  return `# ${o.appName}

A [Hypen](https://github.com/hypen-lang) app running on Cloudflare Workers +
Durable Objects. Scaffolded by \`create-hypen-cf\`.

## Develop

\`\`\`bash
bun install
bun run dev          # wrangler dev → http://localhost:8787
\`\`\`

Connect any Hypen client (DOM, Canvas, desktop, iOS) to \`ws://localhost:8787/ws\`.

## Deploy

\`\`\`bash
bunx wrangler login  # one-time
bun run deploy
\`\`\`

## Structure

- \`src/worker.ts\` — routes WebSocket upgrades to a \`${o.doClass}\` instance.
- \`src/do.ts\` — \`${o.doClass}\`, a thin \`HypenDurableObject\` subclass.
- \`src/engine.ts\` — \`CFEngine\`, bound to the WASM via \`@hypen-space/cf\`.
- \`src/components/${o.moduleName}.ts\` — the primary module + its UI.

## Next steps

- **More screens?** Add modules with \`app.module("Name").defineState(...).ui(...)\`,
  put a \`Router { Route(...) }\` block in your App template, and pass \`app\` +
  \`componentTemplates\` to \`getConfig()\`. See the calorie-counter and social
  examples in the Hypen repo.
- **State persistence?** Add \`.persist(durableObjectStore(session()))\` to a
  module (imported from \`@hypen-space/cf\`); the DO binds storage automatically.
- **A database?** Use the DO's synchronous \`state.storage.sql\` (see the
  examples' \`db.ts\` bun:sqlite shim). Note: a single physical
  \`@hypen-space/core\` copy must resolve in the bundle — a clean
  \`bun install\` ensures this.
`;
}

function gitignore(): string {
  return `node_modules/
dist/
.wrangler/
.dev.vars
`;
}

/**
 * Generate every file for a new CF app as a path→content map (paths relative
 * to the new project directory).
 */
export function scaffold(opts: ScaffoldOptions): Map<string, string> {
  const o = resolveOptions(opts);
  return new Map<string, string>([
    ["package.json", packageJson(o)],
    ["wrangler.jsonc", wranglerJsonc(o)],
    ["tsconfig.json", tsconfig()],
    [".gitignore", gitignore()],
    ["README.md", readmeMd(o)],
    ["src/worker.ts", workerTs(o)],
    ["src/do.ts", doTs(o)],
    ["src/engine.ts", engineTs()],
    [`src/components/${o.moduleName}.ts`, appComponentTs(o)],
  ]);
}
