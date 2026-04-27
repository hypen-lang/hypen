/**
 * Data Source Plugin System for Hypen
 *
 * Enables live subscription databases (SpacetimeDB, Firebase, Convex, Electric SQL)
 * to push data into the Hypen reactive engine via a unified plugin interface.
 *
 * UI bindings use the `@provider.path` syntax:
 *   - `@spacetime.messages` → SpacetimeDB messages table
 *   - `@firebase.user.profile` → Firebase user profile
 *   - `@convex.tasks` → Convex tasks table
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

/** Connection status for a data source provider */
export type DataSourceStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Describes a subscription to a table or query */
export interface DataSourceQuery {
  /** Table or collection name (e.g., "messages", "users") */
  table: string;
  /** Optional filter criteria */
  filter?: Record<string, unknown>;
  /** Optional raw query string (e.g., SQL for SpacetimeDB) */
  sql?: string;
}

/** Handle returned by subscribe() — call unsubscribe() to stop receiving updates */
export interface DataSourceSubscription {
  /** Stop receiving updates for this subscription */
  unsubscribe(): void;
  /** Current subscription status */
  status: "pending" | "applied" | "error";
  /** Error details if status is "error" */
  error?: Error;
}

/** Describes a batch of changes pushed by a plugin */
export interface DataSourceChange {
  /** Changed paths relative to the provider root (e.g., ["messages", "users"]) */
  paths: string[];
  /** New values at those paths */
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin Interface
// ---------------------------------------------------------------------------

/**
 * Interface that all data source plugins must implement.
 *
 * A plugin manages the connection lifecycle and translates database-specific
 * events (row inserts, updates, deletes) into `DataSourceChange` objects that
 * the Hypen engine can consume.
 *
 * @typeParam TConfig - Plugin-specific configuration type
 *
 * @example
 * ```typescript
 * class SpacetimeDBPlugin implements DataSourcePlugin<SpacetimeDBConfig> {
 *   readonly name = "spacetime";
 *   status: DataSourceStatus = "disconnected";
 *
 *   async connect(config: SpacetimeDBConfig, onChange: (change: DataSourceChange) => void) {
 *     // Connect to SpacetimeDB, subscribe to tables, push changes via onChange
 *   }
 *   // ...
 * }
 * ```
 */
export interface DataSourcePlugin<TConfig = unknown> {
  /** Unique provider name (e.g., "spacetime", "firebase", "convex") */
  readonly name: string;

  /** Current connection status */
  status: DataSourceStatus;

  /**
   * Connect to the data source and begin pushing changes.
   *
   * @param config - Plugin-specific configuration
   * @param onChange - Callback to push data changes into the engine.
   *   The plugin MUST call this whenever subscribed data changes.
   */
  connect(config: TConfig, onChange: (change: DataSourceChange) => void): Promise<void>;

  /**
   * Subscribe to a specific table or query.
   * Returns a handle to unsubscribe later.
   */
  subscribe(query: DataSourceQuery): DataSourceSubscription;

  /**
   * Call a remote procedure / reducer / mutation.
   *
   * @param method - Method name (e.g., "sendMessage" for SpacetimeDB reducer)
   * @param args - Arguments to pass
   * @returns The result from the remote call
   */
  call(method: string, ...args: unknown[]): Promise<unknown>;

  /**
   * Disconnect from the data source and clean up all subscriptions.
   */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Data Source Manager
// ---------------------------------------------------------------------------

/** Interface for the engine's data source operations (maps to WASM setContext/removeContext) */
export interface IDataSourceEngine {
  /**
   * Set (or replace) a named data source context.
   * Registers the provider, stores the data, and re-renders bound nodes.
   * Sparse merging should happen at the SDK layer before calling this.
   */
  setContext(name: string, data: Record<string, unknown>): void;
  /**
   * Remove a data source context entirely.
   * Drops the provider's state and re-renders bound nodes (they resolve to null).
   */
  removeContext(name: string): void;
}

/**
 * Manages data source plugin lifecycles and bridges them to the Hypen engine.
 *
 * The manager:
 * 1. Registers plugins with the engine (creates state slots)
 * 2. Connects plugins and wires their onChange callbacks to engine updates
 * 3. Manages subscription lifecycles
 * 4. Handles cleanup on disconnect
 *
 * @example
 * ```typescript
 * const manager = new DataSourceManager(engine);
 *
 * // Register and connect a SpacetimeDB plugin
 * await manager.use(new SpacetimeDBPlugin(), {
 *   uri: "ws://localhost:3000",
 *   moduleName: "chat",
 *   tables: ["user", "message"],
 * });
 *
 * // Access plugin for mutations
 * await manager.get("spacetime").call("sendMessage", "Hello!");
 *
 * // Clean up
 * await manager.disconnectAll();
 * ```
 */
export class DataSourceManager {
  private plugins = new Map<string, DataSourcePlugin>();
  private configs = new Map<string, unknown>();
  /** Accumulated state per provider — sparse merging happens here before setContext */
  private state = new Map<string, Record<string, unknown>>();
  private engine: IDataSourceEngine;

  constructor(engine: IDataSourceEngine) {
    this.engine = engine;
  }

  /**
   * Register, connect, and start a data source plugin.
   *
   * @param plugin - The plugin instance
   * @param config - Plugin-specific configuration
   */
  async use<C>(plugin: DataSourcePlugin<C>, config: C): Promise<void> {
    const { name } = plugin;

    // Initialize state slot
    this.state.set(name, {});

    // Store references
    this.plugins.set(name, plugin as DataSourcePlugin);
    this.configs.set(name, config);

    // Connect the plugin with an onChange callback that merges sparse data
    // and pushes the full state via setContext
    await plugin.connect(config, (change: DataSourceChange) => {
      // Merge changed paths into the accumulated state
      const current = this.state.get(name) ?? {};
      for (const path of change.paths) {
        if (path in change.values) {
          current[path] = change.values[path];
        }
      }
      this.state.set(name, current);

      // Push the full merged state to the engine
      this.engine.setContext(name, current);
    });
  }

  /**
   * Get a registered plugin by name.
   * Useful for calling mutations: `manager.get("spacetime").call("sendMessage", text)`
   */
  get<T extends DataSourcePlugin = DataSourcePlugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }

  /** Check if a plugin is registered */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Get all registered provider names */
  getNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Get the status of a specific plugin */
  getStatus(name: string): DataSourceStatus | undefined {
    return this.plugins.get(name)?.status;
  }

  /**
   * Disconnect and remove a specific plugin.
   */
  async remove(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin) {
      await plugin.disconnect();
      this.plugins.delete(name);
      this.configs.delete(name);
      this.state.delete(name);
      this.engine.removeContext(name);
    }
  }

  /**
   * Disconnect all plugins and clean up.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    await Promise.all(names.map((name) => this.remove(name)));
  }
}
