import { WasmEngine } from "./hypen-web/packages/core/wasm-node/hypen_engine.js";
import { readdirSync, readFileSync } from "fs";

const engine = new WasmEngine();

// Test all component files
const componentFiles = readdirSync("./component-gallery-server/components").filter(f => f.endsWith(".ts"));
const applicatorFiles = readdirSync("./component-gallery-server/applicators").filter(f => f.endsWith(".ts"));

let passed = 0;
let failed = 0;

for (const file of componentFiles) {
  const mod = await import(`./component-gallery-server/components/${file}`);
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
  const mod = await import(`./component-gallery-server/applicators/${file}`);
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
