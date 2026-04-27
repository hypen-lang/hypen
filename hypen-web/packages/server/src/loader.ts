/**
 * Component Loader
 *
 * A stateful registry for Hypen components with filesystem loading helpers.
 * Works in both Node.js and Bun environments.
 *
 * NOTE: This is intentionally distinct from `discovery.ts`. They are NOT
 * duplicates:
 *
 *   - `loader.ts` (this file) exposes a `ComponentLoader` **class** — a mutable
 *     in-memory registry (register / get / has / getNames / clear) plus
 *     eager directory loaders. It's what the `Hypen` orchestrator in
 *     `@hypen-space/web-engine` plugs into via the `ComponentLoaderLike`
 *     interface, and it's what users call `componentLoader.register()` on
 *     when wiring components by hand.
 *
 *   - `discovery.ts` exposes **stateless functions** (`discoverComponents`,
 *     `loadDiscoveredComponents`, `watchComponents`, `generateComponentsCode`)
 *     that walk a directory tree and return arrays / Maps of discovered
 *     component metadata. It has no registry and no mutation.
 *
 * Typical flow: `discoverComponents()` -> `loadDiscoveredComponents()` ->
 * iterate and call `componentLoader.register()` for each. They compose; they
 * do not overlap.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { HypenModuleDefinition } from "@hypen-space/core/app";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.loader;

export interface ComponentDefinition {
  name: string;
  module: HypenModuleDefinition<any>;
  template: string; // The .hypen file content
  path: string;
}

export class ComponentLoader {
  private components = new Map<string, ComponentDefinition>();

  /**
   * Register a component with its module and template
   */
  register(
    name: string,
    module: HypenModuleDefinition<any>,
    template: string,
    path?: string
  ): void {
    this.components.set(name, {
      name,
      module,
      template,
      path: path || name,
    });
  }

  /**
   * Get a registered component by name
   */
  get(name: string): ComponentDefinition | undefined {
    return this.components.get(name);
  }

  /**
   * Check if a component is registered
   */
  has(name: string): boolean {
    return this.components.has(name);
  }

  /**
   * Get all registered component names
   */
  getNames(): string[] {
    return Array.from(this.components.keys());
  }

  /**
   * Get all registered components
   */
  getAll(): ComponentDefinition[] {
    return Array.from(this.components.values());
  }

  /**
   * Clear all registered components
   */
  clear(): void {
    this.components.clear();
  }

  /**
   * Load a component from a directory
   * Expects: component.ts and component.hypen in the same directory
   */
  async loadFromDirectory(name: string, dirPath: string): Promise<void> {
    try {
      // Dynamic import of the module
      const modulePath = join(dirPath, "component.ts");
      const moduleExport = await import(modulePath);
      const module = moduleExport.default as HypenModuleDefinition<any>;

      // Read the .hypen template file
      const templatePath = join(dirPath, "component.hypen");
      const template = readFileSync(templatePath, "utf-8");

      // Register the component
      this.register(name, module, template, dirPath);

      log.debug(`Loaded component: ${name} from ${dirPath}`);
    } catch (error) {
      log.error(`Failed to load component ${name} from ${dirPath}:`, error);
      throw error;
    }
  }

  /**
   * Auto-load all components from a directory
   * Scans for subdirectories containing component.ts and component.hypen
   */
  async loadFromComponentsDir(baseDir: string): Promise<void> {
    try {
      if (!existsSync(baseDir)) {
        log.warn(`Components directory not found: ${baseDir}`);
        return;
      }

      const entries = readdirSync(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const componentDir = join(baseDir, entry.name);
        const hypenPath = join(componentDir, "component.hypen");

        // Only load if component.hypen exists
        if (existsSync(hypenPath)) {
          await this.loadFromDirectory(entry.name, componentDir);
        }
      }

      log.debug(`Loaded ${this.components.size} components from ${baseDir}`);
    } catch (error) {
      log.error(`Failed to load components from ${baseDir}:`, error);
      throw error;
    }
  }
}

// Global component loader instance
export const componentLoader = new ComponentLoader();
