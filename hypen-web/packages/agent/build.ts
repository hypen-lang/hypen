import { $ } from "bun";

console.log("Building @hypen-space/agent...");

await $`rm -rf dist`;

await Bun.build({
  entrypoints: ["./src/index.ts", "./src/server.ts", "./src/stdio.ts"],
  root: "./src",
  outdir: "./dist",
  // Node/Bun only: the transport is stdin/stdout. A browser has no stdio,
  // and an in-browser agent surface would be a different transport over the
  // same `HypenMcpServer`.
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: ["@hypen-space/core", "@hypen-space/core/*"],
});

console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/agent built successfully");
