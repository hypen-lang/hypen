import { WasmEngine } from "../hypen-web/packages/server/wasm-node/hypen_engine.js";
import { readdirSync } from "fs";
import { join } from "path";

const engine = new WasmEngine();
engine.registerDefaultPrimitives();

// Test all component files (paths relative to this file, not the cwd)
const componentsDir = join(import.meta.dir, "components");
const applicatorsDir = join(import.meta.dir, "applicators");
const componentFiles = readdirSync(componentsDir).filter(f => f.endsWith(".ts"));
const applicatorFiles = readdirSync(applicatorsDir).filter(f => f.endsWith(".ts"));

let passed = 0;
let failed = 0;

for (const file of componentFiles) {
  const mod = await import(join(componentsDir, file));
  const key = Object.keys(mod)[0];
  const example = mod[key];

  try {
    engine.renderSource(example.ui.trim());
    passed++;
  } catch (e: any) {
    console.error(`FAILED: components/${file}:`, e.message?.substring(0, 80));
    failed++;
  }
}

for (const file of applicatorFiles) {
  const mod = await import(join(applicatorsDir, file));
  const key = Object.keys(mod)[0];
  const example = mod[key];

  try {
    engine.renderSource(example.ui.trim());
    passed++;
  } catch (e: any) {
    console.error(`FAILED: applicators/${file}:`, e.message?.substring(0, 80));
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
