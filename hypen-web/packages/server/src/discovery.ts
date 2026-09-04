/**
 * Component Discovery
 *
 * Stateless filesystem scan + codegen helpers for Hypen components.
 *
 * Supports multiple conventions:
 *   1. Single-file: ComponentName.ts with .ui(hypen`...`) inline template
 *   2. Folder-based: ComponentName/component.ts + ComponentName/component.hypen
 *   3. Sibling files: ComponentName.ts + ComponentName.hypen
 *   4. Index-based: ComponentName/index.ts + ComponentName/index.hypen
 *
 * NOTE: This module is distinct from `loader.ts`. Discovery is pure
 * functions that return data; it holds no registry. The `ComponentLoader`
 * class in `loader.ts` is the mutable registry that components get
 * registered into. The two compose: `discoverComponents()` ->
 * `loadDiscoveredComponents()` -> feed results into a `ComponentLoader`.
 */

import { existsSync, readdirSync, readFileSync, statSync, watch } from "fs";
import { join, basename, dirname, resolve, relative } from "path";
import type { HypenModuleDefinition } from "@hypen-space/core/app";
import { frameworkLoggers } from "@hypen-space/core/logger";

export interface DiscoveredComponent {
  name: string;
  /** Path to .hypen file (null for single-file components with inline templates) */
  hypenPath: string | null;
  /** Path to .ts module file */
  modulePath: string | null;
  /** The UI template (from .hypen file or inline) */
  template: string;
  /** Whether this component has a module (state/actions) */
  hasModule: boolean;
  /** Whether this is a single-file component with inline template */
  isSingleFile: boolean;
}

export interface DiscoveryOptions {
  /**
   * Which naming patterns to look for
   * Default: ["single-file", "folder", "sibling", "index"]
   *
   * - single-file: ComponentName.ts with .ui(hypen`...`) inline template
   * - folder: ComponentName/component.ts + ComponentName/component.hypen
   * - sibling: ComponentName.ts + ComponentName.hypen
   * - index: ComponentName/index.ts + ComponentName/index.hypen
   */
  patterns?: ("single-file" | "folder" | "sibling" | "index")[];

  /**
   * Recursively scan subdirectories
   * Default: true
   */
  recursive?: boolean;

  /**
   * Enable debug logging
   * Default: false
   */
  debug?: boolean;
}

export interface WatchOptions extends DiscoveryOptions {
  /**
   * Callback when components change
   */
  onChange?: (components: DiscoveredComponent[]) => void;

  /**
   * Callback when a component is added
   */
  onAdd?: (component: DiscoveredComponent) => void;

  /**
   * Callback when a component is removed
   */
  onRemove?: (name: string) => void;

  /**
   * Callback when a component is updated
   */
  onUpdate?: (component: DiscoveredComponent) => void;
}

/**
 * Discover all Hypen components in a directory
 */
export async function discoverComponents(
  baseDir: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveredComponent[]> {
  const {
    patterns = ["single-file", "folder", "sibling", "index"],
    recursive = true,
    debug = false,
  } = options;

  const log = debug
    ? (...args: unknown[]) => frameworkLoggers.discovery.debug(...args)
    : () => {};

  const resolvedDir = resolve(baseDir);
  const components: DiscoveredComponent[] = [];
  const seen = new Set<string>();

  log("Scanning directory:", resolvedDir);
  log("Patterns:", patterns);

  // Helper to add a two-file component (.hypen + .ts)
  const addTwoFileComponent = (
    name: string,
    hypenPath: string,
    modulePath: string | null
  ) => {
    if (seen.has(name)) {
      log(`Skipping duplicate: ${name}`);
      return;
    }

    seen.add(name);
    const templateRaw = readFileSync(hypenPath, "utf-8");
    // Preserve import statements in templates — the engine now processes them
    // via parse_document() and resolves imports through the component resolver
    const template = templateRaw.trim();

    components.push({
      name,
      hypenPath,
      modulePath,
      template,
      hasModule: modulePath !== null,
      isSingleFile: false,
    });

    log(`Found: ${name} (two-file, ${modulePath ? "with module" : "stateless"})`);
  };

  // Helper to add a single-file component (.ts with inline template)
  const addSingleFileComponent = (
    name: string,
    modulePath: string,
    template: string
  ) => {
    if (seen.has(name)) {
      log(`Skipping duplicate: ${name}`);
      return;
    }

    seen.add(name);
    components.push({
      name,
      hypenPath: null,
      modulePath,
      template,
      hasModule: true,
      isSingleFile: true,
    });

    log(`Found: ${name} (single-file with inline template)`);
  };

  // Scan directory for folder-based components
  const scanForFolderComponents = (dir: string) => {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folderPath = join(dir, entry.name);
      const componentName = entry.name;

      // Check folder-based pattern: Name/component.hypen
      if (patterns.includes("folder")) {
        const hypenPath = join(folderPath, "component.hypen");
        if (existsSync(hypenPath)) {
          const modulePath = join(folderPath, "component.ts");
          addTwoFileComponent(
            componentName,
            hypenPath,
            existsSync(modulePath) ? modulePath : null
          );
          continue;
        }
      }

      // Check index-based pattern: Name/index.hypen
      if (patterns.includes("index")) {
        const hypenPath = join(folderPath, "index.hypen");
        if (existsSync(hypenPath)) {
          const modulePath = join(folderPath, "index.ts");
          addTwoFileComponent(
            componentName,
            hypenPath,
            existsSync(modulePath) ? modulePath : null
          );
          continue;
        }
      }

      // Recursive scan
      if (recursive) {
        scanForFolderComponents(folderPath);
      }
    }
  };

  // Scan for sibling file components (.ts + .hypen pairs)
  const scanForSiblingComponents = (dir: string) => {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (recursive) {
          scanForSiblingComponents(join(dir, entry.name));
        }
        continue;
      }

      if (!entry.name.endsWith(".hypen")) continue;

      const hypenPath = join(dir, entry.name);
      const baseName = basename(entry.name, ".hypen");

      // Skip component.hypen and index.hypen (handled by folder patterns)
      if (baseName === "component" || baseName === "index") continue;

      const modulePath = join(dir, `${baseName}.ts`);
      addTwoFileComponent(
        baseName,
        hypenPath,
        existsSync(modulePath) ? modulePath : null
      );
    }
  };

  // Scan for single-file components (.ts files with inline templates)
  const scanForSingleFileComponents = async (dir: string) => {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (recursive) {
          await scanForSingleFileComponents(join(dir, entry.name));
        }
        continue;
      }

      // Only look at .ts files
      if (!entry.name.endsWith(".ts")) continue;

      // Skip files that are clearly not components
      if (entry.name.startsWith('.') || entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;

      // Skip component.ts and index.ts (handled by folder patterns)
      const baseName = basename(entry.name, ".ts");
      if (baseName === "component" || baseName === "index") continue;

      // Skip if there's a matching .hypen file (handled by sibling pattern)
      const hypenPath = join(dir, `${baseName}.hypen`);
      if (existsSync(hypenPath)) continue;

      // Check if this looks like a single-file component by looking for .ui( pattern
      const modulePath = join(dir, entry.name);
      const content = readFileSync(modulePath, "utf-8");

      // Quick heuristic: look for .ui( or .ui(hypen pattern
      if (content.includes(".ui(") || content.includes(".ui(hypen")) {
        // Try to import and check for template (mtime-busted so rescans
        // see edited inline templates — see importComponentModule)
        try {
          const moduleExport = await importComponentModule(modulePath);
          const module = moduleExport.default as HypenModuleDefinition<any>;

          if (module && typeof module === "object" && module.template) {
            addSingleFileComponent(baseName, modulePath, module.template);
          } else if (module && typeof module === "object") {
            frameworkLoggers.discovery.warn(`Skipping "${entry.name}": has .ui() pattern but module has no .template property. Did you forget to call .ui(hypen\`...\`)?`);
          }
        } catch (e) {
          // Failed to import, skip this file
          log(`Failed to import potential single-file component: ${entry.name}`, e);
        }
      }
    }
  };

  // Run scans based on patterns
  if (patterns.includes("folder") || patterns.includes("index")) {
    scanForFolderComponents(resolvedDir);
  }

  if (patterns.includes("sibling")) {
    scanForSiblingComponents(resolvedDir);
  }

  if (patterns.includes("single-file")) {
    await scanForSingleFileComponents(resolvedDir);
  }

  log(`Discovered ${components.length} components`);

  return components;
}

/**
 * Import a component's `.ts` module with the file's mtime as a cache-busting
 * query. Plain `import(path)` hits the ESM module cache forever, so a dev
 * server re-running discovery on file change would keep serving the stale
 * module — edited action handlers or initial state would silently never
 * apply until restart. Keying the specifier by mtime re-imports only when
 * the file actually changed (unchanged files reuse the cached instance).
 *
 * Limitation: only the component file itself is busted — helpers it imports
 * stay cached until they're touched too.
 */
async function importComponentModule(modulePath: string): Promise<any> {
  let specifier = modulePath;
  try {
    // Query on the plain path, NOT on a pathToFileURL() href — Bun caches
    // file:// URL imports by path and ignores their query string, while
    // path-with-query specifiers get distinct cache entries in both Bun
    // and Node.
    const mtime = statSync(modulePath).mtimeMs;
    specifier = `${modulePath}?mtime=${mtime}`;
  } catch {
    // File vanished mid-scan — fall back to a plain import and let it
    // surface the real error.
  }
  return import(specifier);
}

/**
 * Load discovered components into a map for use with Hypen
 */
export async function loadDiscoveredComponents(
  components: DiscoveredComponent[]
): Promise<
  Map<
    string,
    {
      name: string;
      module: HypenModuleDefinition<any>;
      template: string;
    }
  >
> {
  // Dynamically import app to avoid circular dependencies
  const { app } = await import("@hypen-space/core/app");

  const loaded = new Map<
    string,
    {
      name: string;
      module: HypenModuleDefinition;
      template: string;
    }
  >();

  for (const component of components) {
    let module: HypenModuleDefinition<any>;
    let template = component.template;

    if (component.modulePath) {
      // Import the TypeScript module (mtime-busted so dev-server reloads
      // pick up edits — see importComponentModule).
      const moduleExport = await importComponentModule(component.modulePath);
      module = moduleExport.default as HypenModuleDefinition<any>;

      // For single-file components, template is already in the module
      if (component.isSingleFile && module.template) {
        template = module.template;
      }
    } else {
      // Register under the discovered name so `pickComponent` in the
      // auto-router can resolve pure-DSL routes (e.g.
      // `Route { Settings() }` with no `.ts` sidecar). Defer to any
      // host-pre-registered definition.
      module = app.get(component.name)
        ?? app.defineState({}, { name: component.name }).build();
    }

    loaded.set(component.name, {
      name: component.name,
      module,
      template,
    });
  }

  return loaded;
}

/**
 * Watch a directory for component changes
 */
export function watchComponents(
  baseDir: string,
  options: WatchOptions = {}
): { stop: () => void } {
  const resolvedDir = resolve(baseDir);
  const {
    onChange,
    onAdd,
    onRemove,
    onUpdate,
    debug = false,
    ...discoveryOptions
  } = options;

  const log = debug
    ? (...args: unknown[]) => frameworkLoggers.discovery.debug("[watch]", ...args)
    : () => {};

  let currentComponents = new Map<string, DiscoveredComponent>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Initial scan
  const initialScan = async () => {
    const components = await discoverComponents(resolvedDir, discoveryOptions);
    currentComponents = new Map(components.map((c) => [c.name, c]));
    onChange?.(components);
  };

  // Debounced rescan
  const rescan = async () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      log("Rescanning...");
      const newComponents = await discoverComponents(
        resolvedDir,
        discoveryOptions
      );
      const newMap = new Map(newComponents.map((c) => [c.name, c]));

      // Find added/removed/updated
      for (const [name, component] of newMap) {
        const existing = currentComponents.get(name);
        if (!existing) {
          log("Added:", name);
          onAdd?.(component);
        } else if (
          existing.template !== component.template ||
          existing.modulePath !== component.modulePath
        ) {
          log("Updated:", name);
          onUpdate?.(component);
        }
      }

      for (const name of currentComponents.keys()) {
        if (!newMap.has(name)) {
          log("Removed:", name);
          onRemove?.(name);
        }
      }

      currentComponents = newMap;
      onChange?.(newComponents);
    }, 100);
  };

  // Start watching. A missing directory must not throw: server-based
  // projects have no components directory at all, and file-based projects
  // can have theirs deleted mid-session. In both cases we watch the
  // nearest existing ancestor and attach the real recursive watcher once
  // the directory appears.
  let watcher: ReturnType<typeof watch> | null = null;
  let stopped = false;

  const attachWatcher = () => {
    if (stopped) return;
    watcher = watch(
      resolvedDir,
      { recursive: true },
      (event, filename) => {
        if (!filename) return;
        if (filename.endsWith(".hypen") || filename.endsWith(".ts")) {
          log("File changed:", filename);
          rescan();
        }
      }
    );
  };

  let creationPoll: ReturnType<typeof setInterval> | null = null;

  const watchForCreation = () => {
    if (stopped) return;
    const onCreated = () => {
      if (stopped || !existsSync(resolvedDir)) return;
      watcher?.close();
      watcher = null;
      if (creationPoll) {
        clearInterval(creationPoll);
        creationPoll = null;
      }
      attachWatcher();
      rescan();
    };
    let ancestor = dirname(resolvedDir);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break; // filesystem root
      ancestor = parent;
    }
    watcher = watch(ancestor, { recursive: true }, onCreated);
    // Recursive watchers can miss events inside directories created after
    // the watch started (the OS-level watch on a new subtree attaches
    // asynchronously), so back the event path with a cheap existence poll.
    creationPoll = setInterval(onCreated, 500);
  };

  if (existsSync(resolvedDir)) {
    attachWatcher();
  } else {
    frameworkLoggers.discovery.warn(
      `Components directory does not exist: ${resolvedDir} — watching for it to be created.`
    );
    watchForCreation();
  }

  // Initial scan
  initialScan();

  return {
    stop: () => {
      stopped = true;
      watcher?.close();
      if (creationPoll) {
        clearInterval(creationPoll);
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  };
}

/**
 * Generate a components object from discovered components
 * Useful for static imports / code generation
 */
export async function generateComponentsCode(
  baseDir: string,
  options: DiscoveryOptions & { outputDir?: string } = {}
): Promise<string> {
  const components = await discoverComponents(baseDir, options);
  const resolvedDir = resolve(baseDir);
  const outputBase = options.outputDir ? resolve(options.outputDir) : resolvedDir;

  let code = `/**
 * Auto-generated component imports
 * Generated by @hypen-space/server discovery
 */

`;

  for (const component of components) {
    let importPath: string | null = null;
    if (component.modulePath) {
      const rel = relative(outputBase, component.modulePath)
        .replace(/\.ts$/, ".js");
      importPath = rel.startsWith(".") ? rel : "./" + rel;
    }

    if (importPath) {
      code += `import ${component.name}Module from "${importPath}";\n`;
    }
  }

  code += `\nimport { app } from "@hypen-space/core";\n\n`;

  for (const component of components) {
    if (component.isSingleFile) {
      // Single-file component: template is in the module itself
      code += `export const ${component.name} = {
  module: ${component.name}Module,
  template: ${component.name}Module.template,
};\n\n`;
    } else if (component.hasModule) {
      // Two-file component with module
      const templateJson = JSON.stringify(component.template);
      code += `export const ${component.name} = {
  module: ${component.name}Module,
  template: ${templateJson},
};\n\n`;
    } else {
      // Stateless two-file component — pass the component name so
      // the generated module auto-registers in the HypenApp registry
      // (see the runtime branch of `loadDiscoveredComponents` for the
      // same reasoning).
      const templateJson = JSON.stringify(component.template);
      code += `const ${component.name}Module = app.defineState({}, { name: ${JSON.stringify(component.name)} }).build();
export const ${component.name} = {
  module: ${component.name}Module,
  template: ${templateJson},
};\n\n`;
    }
  }

  return code;
}
