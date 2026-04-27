/**
 * Enhanced Bun Plugin for Hypen
 *
 * Automatically pairs .hypen templates with their TypeScript modules.
 *
 * Usage:
 *   import Counter from "./Counter.hypen";
 *   // Returns: { module, template, name: "Counter" }
 *
 * Supported conventions:
 *   1. Sibling: Name.ts + Name.hypen
 *   2. Folder: Name/component.ts + Name/component.hypen
 *   3. Index: Name/index.ts + Name/index.hypen
 */

import type { BunPlugin } from "bun";
import { readFileSync, existsSync } from "fs";
import { dirname, basename, join, resolve } from "path";
import { frameworkLoggers } from "@hypen-space/core/logger";

export interface HypenPluginOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Custom patterns for finding module files
   * Default: ["sibling", "component", "index"]
   */
  patterns?: ("sibling" | "component" | "index")[];
}

/**
 * Find the matching TypeScript module for a .hypen file
 */
function findModulePath(
  hypenPath: string,
  patterns: ("sibling" | "component" | "index")[]
): string | null {
  const dir = dirname(hypenPath);
  const baseName = basename(hypenPath, ".hypen");

  for (const pattern of patterns) {
    let candidatePath: string | null = null;

    switch (pattern) {
      case "sibling":
        // Name.hypen -> Name.ts (same directory)
        candidatePath = join(dir, `${baseName}.ts`);
        break;

      case "component":
        // Name/component.hypen -> Name/component.ts
        if (baseName === "component") {
          candidatePath = join(dir, "component.ts");
        }
        break;

      case "index":
        // Name/index.hypen -> Name/index.ts
        if (baseName === "index") {
          candidatePath = join(dir, "index.ts");
        }
        break;
    }

    if (candidatePath && existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Determine the component name from the file path
 */
function getComponentName(hypenPath: string): string {
  const baseName = basename(hypenPath, ".hypen");

  // If file is component.hypen or index.hypen, use parent folder name
  if (baseName === "component" || baseName === "index") {
    return basename(dirname(hypenPath));
  }

  // Otherwise use the file name
  return baseName;
}

/**
 * Parse import statements from Hypen DSL (for future use)
 */
function parseImports(
  text: string
): Array<{ names: string[]; source: string }> {
  const imports: Array<{ names: string[]; source: string }> = [];
  const importRegex =
    /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;

  let match;
  while ((match = importRegex.exec(text)) !== null) {
    const [, namedImports, defaultImport, source] = match;

    if (!source) continue;

    let names: string[];
    if (namedImports) {
      names = namedImports
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
    } else if (defaultImport) {
      names = [defaultImport];
    } else {
      continue;
    }

    imports.push({ names, source });
  }

  return imports;
}

/**
 * Remove import statements from Hypen template
 */
function removeImports(text: string): string {
  return text.replace(
    /import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*/g,
    ""
  );
}

/**
 * Create the enhanced Hypen plugin for Bun
 */
export function hypenPlugin(options: HypenPluginOptions = {}): BunPlugin {
  const { debug = false, patterns = ["sibling", "component", "index"] } =
    options;

  const log = debug
    ? (...args: unknown[]) => frameworkLoggers.plugin.debug(...args)
    : () => {};

  return {
    name: "hypen-loader",
    async setup(build) {
      build.onLoad({ filter: /\.hypen$/ }, async (args) => {
        const hypenPath = resolve(args.path);
        log("Loading:", hypenPath);

        // Read the template
        const templateRaw = readFileSync(hypenPath, "utf-8");

        // Parse and remove imports
        const imports = parseImports(templateRaw);
        const template = removeImports(templateRaw).trim();

        if (imports.length > 0) {
          log("Found imports:", imports);
        }

        // Get component name
        const componentName = getComponentName(hypenPath);
        log("Component name:", componentName);

        // Find matching module
        const modulePath = findModulePath(hypenPath, patterns);
        log("Module path:", modulePath);

        let contents: string;

        if (modulePath) {
          // Has a TypeScript module - import it
          const relativeModulePath = modulePath.replace(/\.ts$/, ".js");
          contents = `
import _module from "${relativeModulePath}";
export const module = _module;
export const template = ${JSON.stringify(template)};
export const name = ${JSON.stringify(componentName)};
export default { module: _module, template: ${JSON.stringify(template)}, name: ${JSON.stringify(componentName)} };
`;
        } else {
          // No TypeScript module - create stateless component
          log("No module found, creating stateless component");
          contents = `
import { app } from "@hypen-space/core";
const _module = app.defineState({}).build();
export const module = _module;
export const template = ${JSON.stringify(template)};
export const name = ${JSON.stringify(componentName)};
export default { module: _module, template: ${JSON.stringify(template)}, name: ${JSON.stringify(componentName)} };
`;
        }

        return {
          contents,
          loader: "js",
        };
      });
    },
  };
}

/**
 * Default plugin instance with standard options
 */
export const defaultHypenPlugin = hypenPlugin();

/**
 * Register the plugin globally (call this in your preload file)
 */
export function registerHypenPlugin(options?: HypenPluginOptions): void {
  Bun.plugin(hypenPlugin(options));
}

export default hypenPlugin;
