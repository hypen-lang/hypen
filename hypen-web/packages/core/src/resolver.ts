/**
 * Component Resolver
 * Resolves component imports from local paths or web URLs
 */

export interface ImportStatement {
  clause: ImportClause;
  source: ImportSource;
}

export type ImportClause =
  | { type: "named"; names: string[] }
  | { type: "default"; name: string };

export type ImportSource =
  | { type: "local"; path: string }
  | { type: "url"; url: string };

export interface ComponentDefinition {
  module: any;
  template: string;
}

export interface ResolverOptions {
  /**
   * Base directory for resolving relative local paths
   * Defaults to current working directory
   */
  baseDir?: string;

  /**
   * Cache resolved components to avoid re-fetching
   * Defaults to true
   */
  cache?: boolean;

  /**
   * Custom fetch function for URL imports
   * Useful for adding authentication, custom headers, etc.
   */
  customFetch?: (url: string) => Promise<string>;

  /**
   * Module registry for looking up pre-registered module definitions.
   * When set, the resolver will check the registry before doing file I/O.
   */
  moduleRegistry?: { has: (name: string) => boolean; get: (name: string) => any };
}

/**
 * Component Resolver
 * Resolves and loads components from local files or remote URLs
 */
export class ComponentResolver {
  private cache = new Map<string, ComponentDefinition>();
  private options: Required<Pick<ResolverOptions, 'baseDir' | 'cache' | 'customFetch'>> & Pick<ResolverOptions, 'moduleRegistry'>;

  private moduleRegistry?: { has: (name: string) => boolean; get: (name: string) => any };

  constructor(options: ResolverOptions = {}) {
    this.options = {
      baseDir: options.baseDir || process.cwd(),
      cache: options.cache ?? true,
      customFetch: options.customFetch || this.defaultFetch.bind(this),
      moduleRegistry: options.moduleRegistry,
    };
    this.moduleRegistry = options.moduleRegistry;
  }

  /**
   * Resolve a component from an import statement.
   * Checks the module registry first (if available), then falls back to file I/O.
   */
  async resolve(
    importStmt: ImportStatement
  ): Promise<Record<string, ComponentDefinition>> {
    // Check module registry first — if a component is pre-registered,
    // use its template directly (it will be mounted as a full module)
    if (this.moduleRegistry) {
      const names = importStmt.clause.type === "named"
        ? importStmt.clause.names
        : [importStmt.clause.name];

      const allFound = names.every(name => this.moduleRegistry!.has(name));
      if (allFound) {
        const result: Record<string, ComponentDefinition> = {};
        for (const name of names) {
          const def = this.moduleRegistry!.get(name);
          result[name] = {
            module: def,
            template: def?.template || "",
          };
        }
        return result;
      }
    }

    const sourcePath = this.getSourcePath(importStmt.source);

    // Check cache first
    if (this.options.cache && this.cache.has(sourcePath)) {
      const cached = this.cache.get(sourcePath)!;
      return this.extractComponents(importStmt.clause, cached);
    }

    // Load the component
    let component: ComponentDefinition;
    if (importStmt.source.type === "local") {
      component = await this.resolveLocal(importStmt.source.path);
    } else {
      component = await this.resolveUrl(importStmt.source.url);
    }

    // Cache it
    if (this.options.cache) {
      this.cache.set(sourcePath, component);
    }

    return this.extractComponents(importStmt.clause, component);
  }

  /**
   * Resolve a component from a local file path
   */
  private async resolveLocal(path: string): Promise<ComponentDefinition> {
    const { resolve, join } = await import("path");
    const { readFile } = await import("fs/promises");

    const basePath = resolve(this.options.baseDir, path);

    // Try .hypen extension
    const hypenPath = basePath.endsWith(".hypen")
      ? basePath
      : `${basePath}.hypen`;

    const template = await readFile(hypenPath, "utf-8");

    // Try loading sibling .ts module (stateless components have no module)
    const modulePath = hypenPath.replace(/\.hypen$/, ".ts");
    let module = {};
    try {
      module = await import(modulePath);
    } catch {
      // Stateless component — no module file
    }

    return { module, template };
  }

  /**
   * Resolve a component from a URL
   */
  private async resolveUrl(url: string): Promise<ComponentDefinition> {
    try {
      const response = await this.options.customFetch(url);
      const data = JSON.parse(response);

      // Expected format: { module: {...}, template: "..." }
      if (!data.module || !data.template) {
        throw new Error(
          `Invalid component format from ${url}. Expected { module, template }`
        );
      }

      return data;
    } catch (error) {
      throw new Error(
        `Failed to resolve component from ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Default fetch implementation
   */
  private async defaultFetch(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }

  /**
   * Extract the requested components based on the import clause
   */
  private extractComponents(
    clause: ImportClause,
    component: ComponentDefinition
  ): Record<string, ComponentDefinition> {
    if (clause.type === "default") {
      return {
        [clause.name]: component,
      };
    } else {
      // Named imports - for now, we only support single exports
      // In the future, we could support exporting multiple components
      // from a single file
      const result: Record<string, ComponentDefinition> = {};
      for (const name of clause.names) {
        result[name] = component;
      }
      return result;
    }
  }

  /**
   * Get the source path as a string (for caching)
   */
  private getSourcePath(source: ImportSource): string {
    return source.type === "local" ? source.path : source.url;
  }

  /**
   * Clear the component cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Parse import statements from Hypen DSL text
   * This is a simple parser that extracts import statements
   */
  static parseImports(text: string): ImportStatement[] {
    const imports: ImportStatement[] = [];
    const importRegex =
      /import\s+(?:(\{[^}]*\})|(\w+))\s+from\s+["']([^"']+)["']/g;

    let match;
    while ((match = importRegex.exec(text)) !== null) {
      const [, namedImports, defaultImport, source] = match;

      if (!source) continue;

      let clause: ImportClause;
      if (namedImports) {
        // Named imports: { Button, Card }
        const names = namedImports
          .slice(1, -1) // Remove { and }
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n.length > 0);
        clause = { type: "named", names };
      } else if (defaultImport) {
        // Default import: HomePage
        clause = { type: "default", name: defaultImport };
      } else {
        continue;
      }

      // Determine if source is URL or local path
      const sourceObj: ImportSource = source.startsWith("http://") ||
        source.startsWith("https://")
        ? { type: "url", url: source }
        : { type: "local", path: source };

      imports.push({ clause, source: sourceObj });
    }

    return imports;
  }
}
