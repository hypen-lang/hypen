import { defineConfig, type Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoBench = resolve(import.meta.dirname, "../..");
const packagesDir = resolve(repoBench, "../../hypen-web/packages");

/**
 * Resolve `@hypen-space/*` against this checkout instead of npm.
 *
 * Each package's own `exports` map is the lookup table. Conditions are tried
 * in the order a browser bundler would use them — `browser`, then `import` —
 * which lands on the same `dist/` an npm consumer gets, so the bundle size
 * this app reports is the bundle size a real Hypen app ships. `scripts/
 * prepare.ts` builds those dists.
 *
 * The `bun` condition (raw `src/`) is the fallback, and `@hypen-space/
 * web-engine` uses it: that package's own build script rebuilds the WASM
 * artifacts from scratch, which needs a wasm-pack toolchain. It is four small
 * orchestrator files, so bundling it from source changes nothing measurable.
 */
function hypenLocalPackages(): Plugin {
  const CONDITIONS = ["browser", "import", "default", "bun"] as const;

  const exportsOf = (pkg: string): Record<string, string> => {
    const pkgDir = resolve(packagesDir, pkg);
    const manifest = JSON.parse(
      readFileSync(resolve(pkgDir, "package.json"), "utf8"),
    );
    const out: Record<string, string> = {};
    for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
      if (typeof entry !== "object" || entry === null) continue;
      const table = entry as Record<string, string>;
      for (const condition of CONDITIONS) {
        const target = table[condition];
        if (!target) continue;
        const abs = resolve(pkgDir, target);
        if (!existsSync(abs)) continue;
        out[subpath.replace(/^\.\/?/, "")] = abs;
        break;
      }
    }
    return out;
  };

  const maps = new Map<string, Record<string, string>>();

  return {
    name: "hypen-local-packages",
    enforce: "pre",
    resolveId(id) {
      // `taffy-layout` is a *dynamic* import inside the Canvas layout engine.
      // This app renders to the DOM, so that branch is never taken; stub it
      // rather than adding a WASM layout engine to the bundle we're measuring.
      if (id === "taffy-layout" || id.startsWith("taffy-layout/")) {
        return "\0taffy-layout-stub";
      }

      // The SDK sources live outside this app, so Node resolution from those
      // files never reaches our `node_modules`. Point their third-party
      // imports at the copy this app installed.
      if (id === "@chenglou/pretext") {
        return resolve(
          import.meta.dirname,
          "node_modules/@chenglou/pretext/dist/layout.js",
        );
      }

      const m = /^@hypen-space\/([^/]+)(?:\/(.*))?$/.exec(id);
      if (!m) return null;
      const [, pkg, sub = ""] = m;
      if (!maps.has(pkg)) maps.set(pkg, exportsOf(pkg));
      const table = maps.get(pkg)!;

      const key = sub.replace(/\.js$/, "");
      const hit = table[key] ?? table[sub];
      if (hit && existsSync(hit)) return hit;

      // Not in the exports map (a deep import the package makes of itself):
      // fall back to the obvious source path.
      for (const file of [
        resolve(packagesDir, pkg, "src", `${key || "index"}.ts`),
        resolve(packagesDir, pkg, "src", key, "index.ts"),
      ]) {
        if (existsSync(file)) return file;
      }
      throw new Error(`[hypen-local-packages] cannot resolve ${id}`);
    },
    load(id) {
      if (id === "\0taffy-layout-stub") {
        return "export default {}; export const init = () => {};";
      }
      return null;
    },

    /**
     * `@hypen-space/web` registers its DOM component handlers with synchronous
     * `require()` calls inside otherwise-ESM modules
     * (`dom/components/index.ts`, `dom/components/hypenapp.ts`). Bundlers with
     * CommonJS interop — bun and esbuild, which is what the SDK and the
     * Cloudflare examples use — paper over that; Rollup leaves `require` as an
     * undefined global and the app dies on first render.
     *
     * Rewriting each `require("./x.js")` into a hoisted namespace import is
     * semantics-preserving here: every specifier is a static relative path to
     * a sibling ES module. This is a workaround for a real packaging bug, not
     * a benchmark thumb on the scale — the emitted code is what a static
     * import would have produced anyway.
     */
    transform(code, id) {
      if (!id.includes("/hypen-web/packages/") || !code.includes("require(")) {
        return null;
      }
      const specs = new Map<string, string>();
      const rewritten = code.replace(
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
        (_, spec: string) => {
          let name = specs.get(spec);
          if (!name) {
            name = `__cjs${specs.size}`;
            specs.set(spec, name);
          }
          return name;
        },
      );
      if (specs.size === 0) return null;
      const imports = [...specs]
        .map(([spec, name]) => `import * as ${name} from ${JSON.stringify(spec)};`)
        .join("\n");
      return { code: `${imports}\n${rewritten}`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [hypenLocalPackages()],
  server: { port: 5302, fs: { allow: [repoBench, packagesDir] } },
  preview: { port: 5302 },
  build: {
    target: "es2022",
    // `bench/profile.ts` builds with BENCH_PROFILE=1 into a separate outDir:
    // minified function names make a CPU profile unreadable, and the profile
    // is only ever used to attribute time, never to report a duration.
    minify: process.env.BENCH_PROFILE ? false : "esbuild",
    outDir: process.env.BENCH_PROFILE ? "dist-profile" : "dist",
    modulePreload: { polyfill: false },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
