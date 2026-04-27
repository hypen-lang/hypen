/**
 * File-based Component Example
 *
 * Demonstrates how to use the discovery-based component loading:
 * 1. Define components in separate folders with component.ts + component.hypen
 * 2. Use discoverComponents() to automatically find them
 * 3. Use loadDiscoveredComponents() to import and prepare them
 * 4. Render with renderWithComponents()
 */

import {
  discoverComponents,
  loadDiscoveredComponents,
} from "../../../packages/core/src/index.js";
import { renderWithComponents } from "../../../packages/web/src/index.js";

async function main() {
  console.log("=== File-based Component Example ===\n");

  // 1. Discover all components in the ./components directory
  console.log("Discovering components...");
  const discovered = await discoverComponents("./components", {
    patterns: ["folder"],
    debug: true,
  });

  console.log(`Found ${discovered.length} component(s):`);
  for (const comp of discovered) {
    console.log(`  - ${comp.name} (${comp.hasModule ? "with module" : "stateless"})`);
  }

  // 2. Load the discovered components
  console.log("\nLoading components...");
  const componentsMap = await loadDiscoveredComponents(discovered);

  // 3. Convert to object for renderWithComponents
  const components: Record<string, { module: any; template: string }> = {};
  for (const [name, comp] of componentsMap) {
    components[name] = comp;
  }

  // 4. In a browser environment, you would render to DOM:
  // const hypen = await renderWithComponents(components, "Counter", "#app");

  // For this console example, we'll just log the component info
  console.log("\nLoaded components:");
  for (const [name, comp] of Object.entries(components)) {
    console.log(`  ${name}:`);
    console.log(`    - Module: ${comp.module ? "defined" : "stateless"}`);
    console.log(`    - Template: ${comp.template.substring(0, 50)}...`);
  }

  console.log("\n=== Example Complete ===");
  console.log("\nTo run this in a browser, use:");
  console.log("  bun ../../bin/hypen.ts dev");
}

main().catch(console.error);
