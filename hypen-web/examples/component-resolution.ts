/**
 * Example: Dynamic Component Resolution with Path Context
 *
 * Demonstrates how the engine can dynamically resolve and load components
 * with path-aware resolution, allowing different components with the same name
 * in different directories.
 */

import { Engine } from "../packages/core/src/index.js";
import path from "path";

// Simulate a file-system based component registry
// In a real app, this would use fs.readFileSync()
const componentFiles: Record<string, string> = {
  "/components/Header.hypen": `
    Row {
      Text("My App Header")
    }
    .backgroundColor("blue")
    .padding(16)
  `,

  "/components/Footer.hypen": `
    Row {
      Text("© 2025 My App")
    }
    .padding(8)
    .fontSize(12)
  `,

  "/components/buttons/PrimaryButton.hypen": `
    Row {
      Text("Primary Action")
    }
    .padding(12)
    .backgroundColor("blue")
    .borderRadius(8)
  `,

  "/components/buttons/SecondaryButton.hypen": `
    Row {
      Text("Secondary Action")
    }
    .padding(12)
    .backgroundColor("gray")
    .borderRadius(8)
  `,

  "/pages/Home.hypen": `
    Column {
      Header()

      Text("Welcome home!")

      Button()

      Footer()
    }
  `,
};

async function main() {
  // Create engine instance
  const engine = new Engine();
  await engine.init();

  // Set up component resolver callback with path-aware resolution
  engine.setComponentResolver((componentName: string, contextPath: string | null) => {
    console.log(`Resolving component: ${componentName} (context: ${contextPath || "root"})`);

    // Determine the directory to search in
    const searchDir = contextPath ? path.dirname(contextPath) : "/components";

    // Try to find the component file
    // Priority: 1) Same directory, 2) /components directory
    const possiblePaths = [
      `${searchDir}/${componentName}.hypen`,
      `/components/${componentName}.hypen`,
      `/components/buttons/${componentName}.hypen`,
    ];

    for (const filePath of possiblePaths) {
      if (componentFiles[filePath]) {
        console.log(`Found component at: ${filePath}`);
        return {
          source: componentFiles[filePath],
          path: filePath,
        };
      }
    }

    console.log(`Component not found: ${componentName}`);
    return null;
  });

  // Set up render callback to see the patches
  engine.setRenderCallback((patches: any) => {
    console.log("\nPatches received:", JSON.stringify(patches, null, 2));
  });

  // Render a UI that uses unregistered components
  const hypenSource = `
  Column {
    Header()

    Text("Welcome to my app!")

    Button()

    Footer()
  }
  `;

  console.log("Rendering UI with path-aware component resolution...\n");
  engine.renderSource(hypenSource);

  console.log("\nDone! Components were resolved with path context.");
}

if (import.meta.main) {
  main().catch(console.error);
}
