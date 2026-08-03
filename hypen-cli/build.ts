/**
 * Build script for @hypen-space/cli
 *
 * Compiles TypeScript to JavaScript for npm distribution.
 * Enables `hypen dev` to work directly with Node.js.
 */

import { $ } from "bun";

console.log("Building @hypen-space/cli...\n");

// Clean dist directory
await $`rm -rf dist`;

// Build all entry points
console.log("Compiling TypeScript...");

await Bun.build({
  entrypoints: [
    "./bin/hypen.ts",
    "./src/index.ts",
    "./src/dev.ts",
    "./src/dev-bun.ts",
    "./src/dev-node.ts",
  ],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: [
    "@hypen-space/core",
    "@hypen-space/core/*",
    "@hypen-space/server",
    "@hypen-space/server/*",
    "@hypen-space/web",
    "@hypen-space/web/*",
    "@hypen-space/web-engine",
    "@hypen-space/web-engine/*",
    "esbuild",
  ],
});

console.log("✓ TypeScript compiled\n");

// Prebuild the Studio UI bundle that ships in the package. Published
// installs must not build Studio on the user's machine: under bun's global
// install dir (~/.bun/…) Tailwind's scanner treats every source file as
// hidden and emits zero utility classes, so a runtime build produces a
// completely unstyled Studio. Building here (from a normal checkout path)
// sidesteps that entire class of environment bugs — studio-ui/src/index.tsx
// serves the prebuilt bundle when it exists.
//
// The bundle lives under the CLI's own dist/ (not studio-ui/dist) because
// packers apply .gitignore's `dist/` rule to nested directories, silently
// dropping them from the tarball; top-level `dist` is whitelisted by the
// package.json "files" entry.
console.log("Building Studio UI...");
await $`bun build.ts --outdir=../dist/studio-ui --sourcemap=none`.cwd("studio-ui");

// Fail the publish if the CSS somehow lost its utility classes — an
// unstyled Studio must never ship silently.
let studioCssOk = false;
for (const file of new Bun.Glob("*.css").scanSync("dist/studio-ui")) {
  if (/\.flex\b/.test(await Bun.file(`dist/studio-ui/${file}`).text())) {
    studioCssOk = true;
    break;
  }
}
if (!studioCssOk) {
  console.error(
    "Studio UI CSS contains no Tailwind utilities — is this checkout under a hidden directory?"
  );
  process.exit(1);
}
console.log("✓ Studio UI built\n");

// Generate type declarations
console.log("Generating type declarations...");
await $`bunx tsc --declaration --emitDeclarationOnly --outDir dist`;
console.log("✓ Type declarations generated\n");

// Fix shebang in dist - Bun's bundler may write #!/usr/bin/env node
const hypenJs = await Bun.file("./dist/bin/hypen.js").text();
const fixedShebang = hypenJs.replace(/^#!\/usr\/bin\/env node/, "#!/usr/bin/env bun");
await Bun.write("./dist/bin/hypen.js", fixedShebang);

console.log("Build complete!");
console.log("  dist/bin/hypen.js");
console.log("  dist/src/*.js");
console.log("  dist/**/*.d.ts\n");
