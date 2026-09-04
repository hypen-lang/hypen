import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `shared/` lives outside this app's root, so both the dev server and the
// build need to be told it is in bounds.
const repoBench = resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react()],
  server: { port: 5301, fs: { allow: [repoBench] } },
  preview: { port: 5301 },
  build: {
    target: "es2022",
    // See apps/hypen/vite.config.ts — profiling builds keep function names.
    minify: process.env.BENCH_PROFILE ? false : "esbuild",
    outDir: process.env.BENCH_PROFILE ? "dist-profile" : "dist",
    // One chunk per app keeps the "bytes over the wire" comparison honest —
    // no code-splitting on one side and not the other.
    modulePreload: { polyfill: false },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
