// Componentize the gate module against the CM-async v0.2 WIT.
//
// Single-file module, so no bundle step. Crucially there is NO
// `--disable http`-style pruning of the storage imports and no fallback:
// the build must bind `hypen:storage/local@0.2.0`'s async functions for the
// gate to mean anything. A componentize failure here IS a gate verdict
// (closed) — the Rust runner surfaces jco's stderr as the failure message.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const witDir = resolve(root, "..", "..", "wit-v0_2");
const entry = resolve(root, "src/module.mjs");
const outDir = resolve(root, "dist");
const out = resolve(outDir, "async_gate.wasm");

await mkdir(outDir, { recursive: true });

const args = [
  "componentize",
  entry,
  "--wit",
  witDir,
  "--world-name",
  "module",
  "-o",
  out,
  // Keep the surface minimal but do NOT disable anything the async world
  // needs — the storage imports are the object under test.
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
