// Build the TS module into a WASM Component implementing `hypen:module`.
//
// Two steps:
//   1. Bundle src/index.mjs + its imports into a single file
//      (componentize-js doesn't follow relative imports — needs a
//      pre-bundled entry).
//   2. Run `jco componentize` on the bundle against the canonical WIT.
//
// In a real Hypen SDK this would be `hypen build` — a single command
// hiding the WIT plumbing. For the spike we shell out so the build is
// auditable.

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const witDir = resolve(root, "..", "..", "wit");
const entry = resolve(root, "src/index.mjs");
const outDir = resolve(root, "dist");
const bundle = resolve(outDir, "index.bundle.mjs");
const out = resolve(outDir, "ts_counter.wasm");

await mkdir(outDir, { recursive: true });

// 1. Bundle.
console.log(`bundling ${entry} → ${bundle}`);
await build({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});

// 2. Componentize.
const args = [
  "componentize",
  bundle,
  "--wit",
  witDir,
  "--world-name",
  "module",
  "-o",
  out,
  // The counter doesn't need clocks/random/http. Disabling shrinks the
  // output and avoids unused wasi imports. Keep `stdio` so dev-time
  // `console.log` calls still flow somewhere.
  "--disable",
  "clocks",
  "--disable",
  "random",
  "--disable",
  "http",
];

console.log(`jco ${args.join(" ")}`);
const child = spawn("bunx", ["jco", ...args], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => {
  if (code !== 0) {
    console.error(`jco componentize exited with code ${code}`);
    process.exit(code ?? 1);
  }
  console.log(`\n→ wrote ${out}`);
});
