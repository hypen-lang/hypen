/**
 * Node built-in stubs for the TS bundle. A module compiled for WASI has no
 * `fs`, `path`, … — but `@hypen-space/core` references them in lazy code paths
 * a reducer never runs (`.uiFile()`, the component resolver). Stubbing lets
 * the bundle target WASI instead of Node, and the stubs throw on *use*, so a
 * module that really does touch one fails loudly at runtime.
 */

import { createRequire } from "module";
import type { Plugin } from "esbuild";

/** Node built-ins the TS bundle stubs out (the WASI target has none of them). */
const STUBBED_BUILTINS = [
  "fs",
  "fs/promises",
  "path",
  "os",
  "url",
  "crypto",
  "child_process",
  "module",
  "worker_threads",
  "net",
  "tls",
  "http",
  "https",
  "stream",
  "zlib",
] as const;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The named exports a stub for `mod` provides: the real built-in's export
 * names, read from the runtime running the CLI (so `import { join } from
 * "path"` binds instead of failing to bundle or silently becoming
 * `undefined`). Falls back to none if the runtime can't load it.
 */
function builtinExportNames(mod: string): string[] {
  try {
    const real: unknown = createRequire(import.meta.url)(`node:${mod}`);
    if (typeof real !== "object" || real === null) return [];
    return Object.keys(real).filter((k) => k !== "default" && IDENTIFIER.test(k));
  } catch {
    return [];
  }
}

/**
 * Source of the ESM stub for Node built-in `mod`. Every export (the default
 * and each named export) is a Proxy that throws `node:<mod> is not available
 * in the wasm target` as soon as it's *used* — called, constructed, its
 * properties read, or coerced to a primitive. Merely importing (or having the
 * import in a lazy code path that never runs) stays harmless, which is what
 * lets `@hypen-space/core`'s file-loading paths bundle for WASI.
 */
export function nodeStubSource(mod: string, names: string[] = builtinExportNames(mod)): string {
  const spec = JSON.stringify(`node:${mod}`);
  const lines = [
    `// AUTO-GENERATED stub for ${spec} (hypen build --target wasm).`,
    `const fail = (what) => { throw new Error(${spec} + " is not available in the wasm target" + (what ? " (used: " + what + ")" : "")); };`,
    `const stub = (name) => new Proxy(function () {}, {`,
    `  get(_t, prop) {`,
    `    if (prop === Symbol.toPrimitive) return () => fail(name);`,
    `    if (typeof prop === "symbol" || prop === "then" || prop === "__esModule") return undefined;`,
    `    fail(name ? name + "." + prop : prop);`,
    `  },`,
    `  apply() { fail(name); },`,
    `  construct() { fail(name); },`,
    `  set() { fail(name); },`,
    `  has() { fail(name); },`,
    `});`,
    `export default stub("");`,
  ];
  const unique = [...new Set(names)].filter((n) => n !== "default" && IDENTIFIER.test(n));
  unique.forEach((n, i) => lines.push(`const __s${i} = stub(${JSON.stringify(n)});`));
  if (unique.length > 0) {
    lines.push(`export { ${unique.map((n, i) => `__s${i} as ${n}`).join(", ")} };`);
  }
  return lines.join("\n") + "\n";
}

/** esbuild plugin resolving every stubbed Node built-in to `nodeStubSource`. */
export function nodeStubPlugin(): Plugin {
  const escaped = STUBBED_BUILTINS.map((m) => m.replace("/", "\\/")).join("|");
  const builtins = new RegExp(`^(node:)?(${escaped})$`);
  return {
    name: "hypen-stub-node-builtins",
    setup(build) {
      build.onResolve({ filter: builtins }, (args) => ({
        path: args.path.replace(/^node:/, ""),
        namespace: "hypen-node-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "hypen-node-stub" }, (args) => ({
        contents: nodeStubSource(args.path),
        loader: "js",
      }));
    },
  };
}
