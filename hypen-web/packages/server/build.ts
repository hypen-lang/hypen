/**
 * Build script for @hypen-space/server
 *
 * Compiles TypeScript to JavaScript for npm distribution.
 */

import { $ } from "bun";

console.log("Building @hypen-space/server...");

// Clean dist directory
await $`rm -rf dist`;

// Copy WASM files for Node.js target
console.log("Copying WASM files...");
await $`rm -rf wasm-node`;
await $`mkdir -p wasm-node`;

// Copy Node.js WASM (uses readFileSync for loading - CJS format)
await $`cp -r ../../../hypen-engine-rs/pkg/nodejs/* wasm-node/`;

// wasm-pack nodejs target doesn't set "type" in package.json, but since parent package
// is "type": "module", we explicitly mark this as CJS to avoid module format confusion
const wasmNodePkg = await Bun.file("wasm-node/package.json").json();
wasmNodePkg.type = "commonjs";
wasmNodePkg.sideEffects = false;
await Bun.write("wasm-node/package.json", JSON.stringify(wasmNodePkg, null, 2) + "\n");

console.log("✓ WASM files copied");

// Build Node.js entrypoints
await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/engine.ts",
    "./src/loader.ts",
    "./src/discovery.ts",
    "./src/plugin.ts",
    "./src/remote/server.ts",
  ],
  root: "./src",
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: [
    "../wasm-node/*",
    "@hypen-space/core",
    "@hypen-space/core/*",
  ],
});

// `../wasm-node/*` stays external verbatim, which is right for top-level
// entries (dist/x.js → <pkg>/wasm-node) but one level short for nested ones
// (dist/remote/server.js would look in dist/wasm-node). Re-point nested
// outputs at the package-root wasm-node and fail if any still dangles.
const { Glob } = await import("bun");
const { dirname, relative, resolve } = await import("path");
const wasmNodeDir = resolve("wasm-node");
for await (const file of new Glob("**/*.js").scan("./dist")) {
  const path = `dist/${file}`;
  const text = await Bun.file(path).text();
  if (!text.includes("../wasm-node/")) continue;
  const rel = relative(resolve(dirname(path)), wasmNodeDir).replaceAll("\\", "/");
  const fixed = text.replaceAll(/(["'])\.\.\/wasm-node\//g, `$1${rel}/`);
  await Bun.write(path, fixed);
  for (const m of fixed.matchAll(/["']((?:\.\.\/)+wasm-node\/[^"']+)["']/g)) {
    if (!(await Bun.file(resolve(dirname(path), m[1])).exists())) {
      throw new Error(`${path}: ${m[1]} does not resolve`);
    }
  }
}
console.log("✓ wasm-node imports resolve from nested entries");

// Pre-bundle the default browser client (RemoteEngine + DOMRenderer, no
// WASM) so RemoteServer can serve it at `/` without needing Bun.build or a
// resolvable @hypen-space/web at runtime. Best-effort: the runtime falls
// back to bundling on demand when this artifact is absent.
console.log("Bundling default web client...");
const clientResult = await Bun.build({
  entrypoints: ["./src/remote/web-client-entry.ts"],
  target: "browser",
  format: "esm",
  minify: true,
});
if (clientResult.success && clientResult.outputs[0]) {
  await Bun.write("dist/web-client.bundle.js", await clientResult.outputs[0].text());
  console.log("✓ Web client bundled");
} else {
  console.warn("⚠ Web client bundle failed (server will bundle at runtime):");
  for (const log of clientResult.logs) console.warn(String(log));
}

// Generate type declarations using tsc
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/server built successfully");
