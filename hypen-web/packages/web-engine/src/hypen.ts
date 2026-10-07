/**
 * Hypen - High-Level API for Web Applications
 *
 * Simple API for rendering Hypen applications (like ReactDOM.render)
 */

import { Engine } from "./engine.js";
import { HypenModuleInstance } from "@hypen-space/core/app";
import type { HypenModuleDefinition } from "@hypen-space/core/app";
import { HypenRouter } from "@hypen-space/core/router";
import { HypenGlobalContext } from "@hypen-space/core/context";
import { Router, Route, Link } from "@hypen-space/core/components";
import { frameworkLoggers, setDebugMode } from "@hypen-space/core/logger";
import { DOMRenderer } from "@hypen-space/web/dom";
import type { DebugConfig } from "@hypen-space/web/dom";

const log = frameworkLoggers.hypen;

export interface HypenConfig {
  /** Base directory for components (default: "./src/components") */
  componentsDir?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom WASM URL */
  wasmUrl?: string;
  /** Custom WASM JS glue URL */
  jsUrl?: string;
  /** Enable re-render heatmap debugging */
  debugHeatmap?: boolean;
  /** Heatmap increment per re-render (default: 5%) */
  heatmapIncrement?: number;
  /** Heatmap fade out duration in ms (default: 2000) */
  heatmapFadeOut?: number;
  /** Component loader instance for loading components */
  loader?: ComponentLoaderLike;
}

/**
 * Minimal interface for component loaders.
 * Allows plugging in @hypen-space/server's ComponentLoader without a hard dependency.
 */
export interface ComponentLoaderLike {
  register(name: string, module: any, template: string, path?: string): void;
  get(name: string): { name: string; module: any; template: string; path: string } | undefined;
  has(name: string): boolean;
  getNames(): string[];
  loadFromComponentsDir?(baseDir: string): Promise<void>;
}

export class Hypen {
  private engine: Engine | null = null;
  private renderer: DOMRenderer | null = null;
  private moduleInstance: HypenModuleInstance<any> | null = null;
  private container: HTMLElement | null = null;
  private config: HypenConfig;
  private router: HypenRouter;
  private globalContext: HypenGlobalContext;
  private moduleInstances = new Map<string, HypenModuleInstance<any>>();
  private componentLoader: ComponentLoaderLike | null = null;

  constructor(config: HypenConfig = {}) {
    this.config = {
      componentsDir: "./src/components",
      debug: false,
      ...config,
    };

    // Enable debug mode if configured
    if (this.config.debug) {
      setDebugMode(true);
    }

    // Initialize router and global context
    this.router = new HypenRouter();
    this.globalContext = new HypenGlobalContext();

    // Use provided loader or create an in-memory one
    this.componentLoader = config.loader ?? createInMemoryLoader();

    // Register built-in components
    this.componentLoader.register("Router", Router, "");
    this.componentLoader.register("Route", Route, "");
    this.componentLoader.register("Link", Link, "");

    // Store hypen engine instance in global context for built-in component access
    (this.globalContext as any).__hypenEngine = this;
  }

  /**
   * Initialize the Hypen runtime
   * Must be called before render()
   */
  async init(): Promise<void> {
    log.debug("Initializing...");

    // Initialize engine
    this.engine = new Engine();
    await this.engine.init({
      wasmUrl: this.config.wasmUrl,
      jsUrl: this.config.jsUrl,
    });

    log.debug("Engine initialized");
  }

  /**
   * Load all components from the components directory
   */
  async loadComponents(componentsDir?: string): Promise<void> {
    const dir = componentsDir || this.config.componentsDir!;

    if (!this.componentLoader?.loadFromComponentsDir) {
      log.warn("Component loader does not support loadFromComponentsDir. Use renderWithComponents() for browser-only setups.");
      return;
    }

    log.debug(`Loading components from ${dir}...`);
    await this.componentLoader.loadFromComponentsDir(dir);
    log.debug(`Loaded ${this.componentLoader.getNames().length} components`);
  }

  /**
   * Render a component to a DOM container
   *
   * @param componentName - Name of the component to render (e.g., "HomePage")
   * @param containerSelector - CSS selector or HTMLElement for the mount point
   */
  async render(
    componentName: string,
    containerSelector: string | HTMLElement
  ): Promise<void> {
    if (!this.engine) {
      throw new Error("[Hypen] Engine not initialized. Call init() first.");
    }

    // Get the container element
    if (typeof containerSelector === "string") {
      const element = document.querySelector(containerSelector);
      if (!element) {
        throw new Error(`[Hypen] Container not found: ${containerSelector}`);
      }
      this.container = element as HTMLElement;
    } else {
      this.container = containerSelector;
    }

    // Get the component definition
    const component = this.componentLoader?.get(componentName);
    if (!component) {
      throw new Error(
        `[Hypen] Component "${componentName}" not found. Available: ${this.componentLoader?.getNames().join(", ")}`
      );
    }

    log.debug(`Rendering ${componentName} to`, this.container);

    // Create renderer with debug config
    this.renderer = new DOMRenderer(this.container, this.engine, {
      enabled: this.config.debugHeatmap || false,
      showHeatmap: this.config.debugHeatmap || false,
      heatmapIncrement: this.config.heatmapIncrement || 5,
      fadeOutDuration: this.config.heatmapFadeOut || 2000,
      maxOpacity: 0.8,
    });

    // Set render callback
    this.engine.setRenderCallback((patches) => {
      log.debug(`Applying ${patches.length} patches`);
      this.renderer!.applyPatches(patches);
    });

    // Set context on renderer for component composition
    this.renderer.setContext(this.router, this.globalContext);

    // Extract module ID from component name or .id() applicator
    const moduleId = this.extractModuleId(componentName, component.template);

    // Create module instance with router and global context
    this.moduleInstance = new HypenModuleInstance(
      this.engine,
      component.module,
      this.router,
      this.globalContext
    );

    // Register module in global context
    this.globalContext.registerModule(moduleId, this.moduleInstance);
    this.moduleInstances.set(moduleId, this.moduleInstance);

    // Connect module state changes to renderer
    this.moduleInstance.onStateChange(() => {
      const mergedState = this.getMergedState();
      log.debug(`State changed, merged state:`, mergedState);
      this.renderer!.updateState(mergedState);
    });

    // Set up component resolver for dynamic component composition
    this.setupComponentResolver();

    // Create module instances for ALL components that have state
    this.createNestedModuleInstances();

    // Render the UI template
    this.engine.renderSource(component.template);

    // Update renderer with initial state
    this.renderer!.updateState(this.getMergedState());

    log.debug(`${componentName} rendered successfully`);
  }

  /**
   * Unmount and cleanup
   */
  async unmount(): Promise<void> {
    log.debug("Unmounting...");

    if (this.moduleInstance) {
      await this.moduleInstance.destroy();
      this.moduleInstance = null;
    }

    if (this.container) {
      this.container.innerHTML = "";
      this.container = null;
    }

    this.renderer = null;

    log.debug("Unmounted");
  }

  /**
   * Get the current module instance
   */
  getModuleInstance(): HypenModuleInstance<any> | null {
    return this.moduleInstance;
  }

  /**
   * Get the current state
   */
  getState(): any {
    return this.moduleInstance?.getState() ?? null;
  }

  /**
   * Get the router instance
   */
  getRouter(): HypenRouter {
    return this.router;
  }

  /**
   * Get the global context
   */
  getGlobalContext(): HypenGlobalContext {
    return this.globalContext;
  }

  /**
   * Register a component with the loader
   */
  registerComponent(name: string, module: any, template: string, path?: string): void {
    this.componentLoader?.register(name, module, template, path);
  }

  /**
   * Enable or disable debug heatmap mode
   */
  setDebugHeatmap(enabled: boolean): void {
    if (this.renderer) {
      this.renderer.setDebugConfig({ enabled, showHeatmap: enabled });
      log.debug(`Debug heatmap ${enabled ? "enabled" : "disabled"}`);
    }
  }

  /**
   * Reset debug tracking for all elements
   */
  resetDebugTracking(): void {
    if (this.renderer) {
      this.renderer.resetDebugTracking();
      log.debug("Debug tracking reset");
    }
  }

  /**
   * Get debug statistics
   */
  getDebugStats(): {
    totalRerenders: number;
    elementCount: number;
    avgRerenders: number;
  } | null {
    return this.renderer?.getDebugStats() || null;
  }

  /**
   * Render a lazy route component into a specific route element
   * This is called by the Router when a route becomes active
   */
  async renderLazyRoute(
    routePath: string,
    componentName: string,
    routeElement: HTMLElement
  ): Promise<void> {
    if (!this.engine || !this.renderer) {
      throw new Error("Engine not initialized");
    }

    // Get the component from the loader
    const component = this.componentLoader?.get(componentName);
    if (!component) {
      throw new Error(`Component ${componentName} not found`);
    }

    // Get the component template
    const template = component.template;
    if (!template) {
      throw new Error(`Component ${componentName} has no template`);
    }

    // Create module instance for this component if it has state
    if (component.module && !this.moduleInstances.has(componentName)) {
      const moduleId = this.extractModuleId(componentName, template);

      const moduleInstance = new HypenModuleInstance(
        this.engine,
        component.module,
        this.router,
        this.globalContext
      );

      this.globalContext.registerModule(moduleId, moduleInstance);
      this.moduleInstances.set(componentName, moduleInstance);

      // Listen to state changes
      moduleInstance.onStateChange(() => {
        const mergedState = this.getMergedState();
        log.debug(`Lazy component ${componentName} state changed:`, mergedState);
        this.renderer!.updateState(mergedState);
      });
    }

    // Wait a tick for module instance to initialize and fetch data
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get the route element's node ID from the renderer
    const routeNodeId = routeElement.dataset.hypenId;
    if (!routeNodeId) {
      throw new Error(`Route element is missing data-hypen-id attribute`);
    }

    // Get the current merged state
    const mergedState = this.getMergedState();

    // Render into the Route element
    this.engine.renderInto(template, routeNodeId, mergedState);

    // Ensure freshly created text nodes are interpolated with current state
    this.renderer!.updateState(mergedState);
  }

  /**
   * Extract module ID from component name or .id() applicator
   */
  private extractModuleId(componentName: string, template: string): string {
    // Look for .id("CustomName") or .id('CustomName') in the template
    const idMatch = template.match(/\.id\(["']([^"']+)["']\)/);
    const matchedId = idMatch?.[1];
    if (matchedId) {
      return matchedId;
    }

    // Default to component name
    return componentName;
  }

  /**
   * Create module instances for all components that have state
   */
  private createNestedModuleInstances(): void {
    // Create built-in Router module instance
    if (Router && !this.moduleInstances.has("Router")) {
      const routerInstance = new HypenModuleInstance(
        this.engine!,
        Router,
        this.router,
        this.globalContext
      );
      this.globalContext.registerModule("Router", routerInstance);
      this.moduleInstances.set("Router", routerInstance);
      routerInstance.onStateChange(() => {
        const mergedState = this.getMergedState();
        log.debug("Router state changed:", mergedState);
        this.renderer!.updateState(mergedState);
      });
    }

    // Get all registered components
    const componentNames = this.componentLoader?.getNames() ?? [];

    for (const name of componentNames) {
      // Skip if already created
      if (this.moduleInstances.has(name)) {
        continue;
      }

      const comp = this.componentLoader?.get(name);
      if (!comp || !comp.module) {
        continue;
      }

      // Create module instance
      log.debug(`Creating nested module instance for: ${name}`);

      const moduleInstance = new HypenModuleInstance(
        this.engine!,
        comp.module,
        this.router,
        this.globalContext
      );

      this.globalContext.registerModule(name, moduleInstance);
      this.moduleInstances.set(name, moduleInstance);

      // Connect state changes to renderer
      moduleInstance.onStateChange(() => {
        const mergedState = this.getMergedState();
        log.debug(`Nested component ${name} state changed:`, mergedState);
        this.renderer!.updateState(mergedState);
      });
    }
  }

  /**
   * Get merged state from all module instances.
   *
   * Reads the LIVE observable state rather than `getState()` snapshots:
   * every consumer (renderer text interpolation, `engine.renderInto`
   * serialization) only reads values, and a snapshot is a full deep clone
   * of every module's state — this runs on EVERY state change, so with a
   * 1,000-row list that was a 1,000-row clone per keystroke. Top-level
   * entries still land in a fresh object; nested values are the live
   * proxies, which interpolation reads straight through.
   */
  private getMergedState(): Record<string, any> {
    const merged: Record<string, any> = {};

    // Include main module state
    if (this.moduleInstance) {
      Object.assign(merged, this.moduleInstance.getLiveState());
    }

    // Include all nested component states
    for (const [, instance] of this.moduleInstances.entries()) {
      Object.assign(merged, instance.getLiveState());
    }

    return merged;
  }

  /**
   * Set up component resolver for the engine
   */
  private setupComponentResolver(): void {
    if (!this.engine) return;

    // List of built-in DOM elements that should NOT be resolved.
    // Kept in sync with the engine's DEFAULT_PRIMITIVES
    // (hypen-engine-rs/src/ir/component.rs), plus the web-only Canvas host
    // this renderer handles natively. `tests/builtin-primitives.test.ts`
    // asserts the two lists agree -- they had drifted apart by SafeArea and
    // Scrubber, which the engine pre-registers itself so the omission never
    // surfaced.
    const builtInElements = new Set([
      "Text",
      "Column",
      "Row",
      "Button",
      "Input",
      "Textarea",
      "Image",
      "Container",
      "Box",
      "Center",
      "List",
      "Spacer",
      "Stack",
      "Divider",
      "Grid",
      "Card",
      "Heading",
      "Checkbox",
      "Select",
      "Switch",
      "Slider",
      "Spinner",
      "Badge",
      "Avatar",
      "ProgressBar",
      "Video",
      "Audio",
      "Paragraph",
      "Icon",
      "SafeArea",
      "Scrubber",
      // Web-only primitives (not in the engine list)
      "Canvas",
      // Chart family (see packages/web/src/dom/components/chart.ts)
      "Chart",
      "Axis",
      "Line",
      "Area",
      "Bars",
      "Points",
      "Rule",
      "Marker",
      "Path",
    ]);

    this.engine.setComponentResolver(
      (componentName: string, contextPath: string | null) => {
        // Don't try to resolve built-in DOM elements
        if (builtInElements.has(componentName)) {
          return null;
        }

        log.debug(`Resolving component: ${componentName} (context: ${contextPath})`);

        // Check if component is registered
        const componentDef = this.componentLoader?.get(componentName);
        if (!componentDef) {
          log.debug(`Component not found: ${componentName}`);
          return null;
        }

        // Router is passthrough, Route is lazy
        const isPassthrough = componentName === "Router";
        const isLazy = componentName === "Route";

        const resolved = {
          source: componentDef.template,
          path: componentDef.path || componentName,
          passthrough: isPassthrough,
          lazy: isLazy,
        };

        const flags = [];
        if (isPassthrough) flags.push("passthrough");
        if (isLazy) flags.push("lazy");
        const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        log.debug(`Resolved ${componentName} -> ${resolved.path}${flagStr}`);

        return resolved;
      }
    );
  }
}

/**
 * Create a simple in-memory component loader for browser use
 */
function createInMemoryLoader(): ComponentLoaderLike {
  const components = new Map<string, { name: string; module: any; template: string; path: string }>();
  return {
    register(name: string, module: any, template: string, path?: string) {
      components.set(name, { name, module, template, path: path || name });
    },
    get(name: string) {
      return components.get(name);
    },
    has(name: string) {
      return components.has(name);
    },
    getNames() {
      return Array.from(components.keys());
    },
  };
}

/**
 * Quick render function (like ReactDOM.render)
 *
 * @example
 * ```typescript
 * import { render } from "@hypen-space/web-engine";
 *
 * await render("HomePage", "#app");
 * ```
 */
export async function render(
  componentName: string,
  containerSelector: string | HTMLElement,
  config?: HypenConfig
): Promise<Hypen> {
  const hypen = new Hypen(config);
  await hypen.init();
  await hypen.loadComponents();
  await hypen.render(componentName, containerSelector);
  return hypen;
}

/**
 * Render with explicit component loading
 *
 * @example
 * ```typescript
 * import { renderWithComponents } from "@hypen-space/web-engine";
 * import HomePage from "./components/HomePage/component";
 * import homePageTemplate from "./components/HomePage/component.hypen";
 *
 * await renderWithComponents(
 *   { HomePage: { module: HomePage, template: homePageTemplate } },
 *   "HomePage",
 *   "#app"
 * );
 * ```
 */
export async function renderWithComponents(
  components: Record<string, { module: HypenModuleDefinition; template: string }>,
  componentName: string,
  containerSelector: string | HTMLElement,
  config?: HypenConfig
): Promise<Hypen> {
  const hypen = new Hypen(config);
  await hypen.init();

  // Register components via the public API
  for (const [name, { module, template }] of Object.entries(components)) {
    let processedTemplate = template;

    // If template starts with "module ComponentName {", extract just the children
    const moduleMatch = template.match(/^\s*module\s+\w+\s*\{([\s\S]*)\}\s*$/);
    if (moduleMatch && moduleMatch[1]) {
      processedTemplate = moduleMatch[1].trim();
    }

    hypen.registerComponent(name, module, processedTemplate);
  }

  await hypen.render(componentName, containerSelector);
  return hypen;
}
