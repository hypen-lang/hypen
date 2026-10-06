/**
 * Hypen App Builder API
 * Implements the stateful module system from RFC-0001
 */

import type { Action, AgentAction, AgentRoute, BoundInput } from "./types.js";
import type { Session } from "./remote/types.js";
import { type Result, Ok, Err, fromPromise, ActionError, HypenError } from "./result.js";
import { DataSourceManager, type DataSourcePlugin, type IDataSourceEngine } from "./datasource.js";
import type { StateStore } from "./persistence.js";

// Interface for engine compatibility (works with both engine.js and engine.browser.js)
export interface IEngine {
  setModule(name: string, actions: string[], stateKeys: string[], initialState: unknown): void;
  registerModule(name: string, actions: string[], stateKeys: string[], initialState: unknown): void;
  onAction(actionName: string, handler: (action: Action) => void | Promise<void>): void;
  /**
   * Apply a sparse state update.
   *
   * @param scope  Lowercase module name to target a named module registered
   *               via `registerModule`. Pass `null` (or empty string) to
   *               target the primary module set via `setModule`.
   * @param paths  Changed state paths (relative to the targeted module).
   * @param values Map of `path -> new value`.
   * @param animation Optional transaction-scoped animation context (Option D
   *               cheap subset): a spec object or bare curve token string.
   *               When present, the engine stamps the resulting patch batch
   *               with a leading `batchAnimation` patch. Omitted = unstamped.
   */
  updateStateSparse(
    scope: string | null,
    paths: string[],
    values: Record<string, unknown>,
    animation?: unknown
  ): void;

  // ── External capability surface ──────────────────────────────────────
  //
  // For callers that are NOT the rendered UI: MCP servers, REST APIs,
  // CLIs, agents. `dispatchAction` above reaches every registered handler
  // — including `__hypen_bind`, which writes an arbitrary state path — so
  // external callers get these guarded entry points instead. The rule and
  // its rationale live in `hypen-engine-rs/src/agent.rs`; never
  // reimplement the guard on this side of the boundary.
  //
  // Optional because `IEngine` is a structural contract that hosts and
  // test doubles implement directly, and the surface is additive: an
  // engine predating it stays assignable. `BaseEngine` implements all of
  // them, so anything built on a real WASM engine always has them.

  /** Every action an external caller may dispatch right now. */
  listActions?(): AgentAction[];
  /**
   * The MCP handshake for this app, composed by the engine from the same
   * declaration tables `listActions` reads. `null` when the underlying
   * engine predates it. Opaque here: transports forward it verbatim.
   */
  mcpManifest?(): unknown;
  /** Every route the app declares, backing `hypen.navigate`'s schema. */
  listRoutes?(): AgentRoute[];
  /** Every `.bind()`-declared writable input, backing `hypen.set_input`. */
  listBindings?(): BoundInput[];
  /**
   * Dispatch on behalf of a caller that is not the rendered UI. Accepts
   * exactly what `listActions` advertises and throws otherwise.
   */
  dispatchExternal?(name: string, payload?: unknown): void;
  /** Read module state, whole or at a path. `null` module = primary module. */
  getStateAt?(module: string | null, path: string | null): unknown;
  /**
   * Drop a module and every action it declared.
   *
   * **Destroy only.** Under the default `persist: true` an off-screen
   * module stays registered on purpose — see `ManagedRouter`.
   */
  unregisterModule?(name: string): void;
}

import { createObservableState, type StateChange, getStateSnapshot, batchStateUpdates } from "./state.js";
import { DND_REORDER_ACTION, DND_PIN_ACTION, applyPathMove } from "./dnd.js";
import type { HypenRouter } from "./router.js";
import { HypenGlobalContext, type ModuleReference } from "./context.js";
import { DeviceContext } from "./remote/device/context.js";
import type { DevicePlane } from "./remote/device/plane.js";
import { createLogger } from "./logger.js";

const log = createLogger("ModuleInstance");

export type ActionContext<P = unknown> = {
  name: string;
  payload?: P;
  sender?: string;
};

export type GlobalContext = {
  getModule: <T = unknown>(id: string) => ModuleReference<T>;
  hasModule: (id: string) => boolean;
  getModuleIds: () => string[];
  getGlobalState: () => Record<string, unknown>;
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: (payload?: unknown) => void) => () => void;
  router: HypenRouter | null;
  /**
   * Device Capability Protocol access (RFC 001 §4). Always present; scoped to
   * this invocation's owner/activation and provenance. Without a negotiated
   * device plane, or from a replayed dispatch, every request returns
   * `unavailable` as a value — never throws, never opens a request.
   *
   * Typed per capability: `device.request("permission.query", { permission:
   * "camera" })`, `device.stream("mic.record", params, {}, { onData })`,
   * and the wrappers `device.camera.capture`, `device.mic.record`,
   * `device.bluetooth.select`, `device.permissions.query/request`; unknown
   * names or ill-typed params are compile errors (`requestUntyped` /
   * `streamUntyped` for names only known at runtime).
   */
  device: DeviceContext;
};

export type LifecycleHandler<T> = (
  state: T,
  context?: GlobalContext
) => void | Promise<void>;

/**
 * Action handler context - all parameters available explicitly
 */
export interface ActionHandlerContext<T, P = unknown> {
  action: ActionContext<P>;
  state: T;
  context: GlobalContext;
  /** Access to registered data source plugins for mutations */
  dataSources: DataSourceAccessor;
}

/**
 * Provides typed access to registered data source plugins.
 * Unknown method calls are forwarded to `plugin.call()`:
 *   `dataSources.spacetime.sendMessage(text)` → `plugin.call("sendMessage", text)`
 *
 * You can also call `.call()` directly if you prefer:
 *   `dataSources.spacetime.call("sendMessage", text)`
 */
export interface DataSourceAccessor {
  [providerName: string]: DataSourcePlugin & Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/**
 * Action handler - receives all context in a single object
 */
export type ActionHandler<T, P = unknown> = (ctx: ActionHandlerContext<T, P>) => void | Promise<void>;

/**
 * Context passed to onDisconnect handler
 */
export interface DisconnectContext<T> {
  /** Current state snapshot (ready to serialize and save) */
  state: T;
  /** Session information */
  session: Session;
}

/**
 * Context passed to onReconnect handler
 */
export interface ReconnectContext<T> {
  /** Session information */
  session: Session;
  /** Call this with saved state to restore it */
  restore: (savedState: T) => void;
}

/**
 * Context passed to onExpire handler
 */
export interface ExpireContext {
  /** Session information */
  session: Session;
}

/**
 * Handler called when client disconnects (session still alive for TTL)
 */
export type DisconnectHandler<T> = (ctx: DisconnectContext<T>) => void | Promise<void>;

/**
 * Handler called when client reconnects with existing session
 */
export type ReconnectHandler<T> = (ctx: ReconnectContext<T>) => void | Promise<void>;

/**
 * Handler called when session TTL expires (client never reconnected)
 */
export type ExpireHandler = (ctx: ExpireContext) => void | Promise<void>;

/**
 * Context passed to onError handler
 */
export interface ErrorContext<T> {
  /** The error that occurred */
  error: HypenError;
  /** Current state (for inspection, not mutation during error handling) */
  state: T;
  /** The action name if error occurred in an action handler */
  actionName?: string;
  /** The lifecycle phase if error occurred in a lifecycle handler */
  lifecycle?: "created" | "activated" | "deactivated" | "destroyed" | "disconnect" | "reconnect" | "expire";
}

/**
 * Error handler return type - controls error propagation
 */
export type ErrorHandlerResult =
  | void                    // Continue with default behavior (log + emit)
  | { handled: true }       // Error was handled, skip default behavior
  | { retry: true }         // Retry the operation (only for actions)
  | { rethrow: true };      // Re-throw the error

/**
 * Handler called when an error occurs in the module
 */
export type ErrorHandler<T> = (ctx: ErrorContext<T>) => ErrorHandlerResult | Promise<ErrorHandlerResult>;

export interface HypenModuleDefinition<T = unknown> {
  name?: string;
  actions: string[];
  stateKeys: string[];
  persist?: boolean;
  version?: number;
  initialState: T;
  /**
   * Inline UI template for single-file components.
   * Set via the `.ui(hypen`...`)` method.
   */
  template?: string;
  /**
   * Data source plugins registered via `.useDataSource()`.
   * Each entry contains the plugin and its configuration.
   */
  dataSources?: Array<{ plugin: DataSourcePlugin; config: unknown }>;
  /**
   * Pluggable state store for persistence across sessions.
   * Set via the `.persist(store)` builder method.
   */
  stateStore?: StateStore<T>;
  handlers: {
    onCreated?: LifecycleHandler<T>;
    /**
     * Called every time the module becomes the active route target.
     * Runs after `onCreated` on first mount, and again on each re-mount
     * from the ManagedRouter's persistence cache. Use for data refresh,
     * subscription (re)connects, or any "screen became visible" work.
     */
    onActivated?: LifecycleHandler<T>;
    /**
     * Called every time the module stops being the active route target.
     * Runs before the module is cached for persistence OR before
     * `onDestroyed` if the module is being torn down. Use for pausing
     * timers, tearing down ephemeral subscriptions, etc.
     */
    onDeactivated?: LifecycleHandler<T>;
    onAction: Map<string, ActionHandler<T, any>>;
    onDestroyed?: LifecycleHandler<T>;
    /** Called when client disconnects (session persists for TTL) */
    onDisconnect?: DisconnectHandler<T>;
    /** Called when client reconnects with existing session */
    onReconnect?: ReconnectHandler<T>;
    /** Called when session TTL expires */
    onExpire?: ExpireHandler;
    /** Called when any error occurs in the module */
    onError?: ErrorHandler<T>;
  };
}

/**
 * Alias for HypenModuleDefinition for backward compatibility
 */
export type HypenModule<T = unknown> = HypenModuleDefinition<T>;

/**
 * Builder for creating Hypen app modules
 */
export class HypenAppBuilder<T> {
  private initialState: T;
  private options: { persist?: boolean; version?: number; name?: string };
  private createdHandler?: LifecycleHandler<T>;
  private activatedHandler?: LifecycleHandler<T>;
  private deactivatedHandler?: LifecycleHandler<T>;
  private actionHandlers: Map<string, ActionHandler<T, any>> = new Map();
  private destroyedHandler?: LifecycleHandler<T>;
  private disconnectHandler?: DisconnectHandler<T>;
  private reconnectHandler?: ReconnectHandler<T>;
  private expireHandler?: ExpireHandler;
  private errorHandler?: ErrorHandler<T>;
  private template?: string;
  private _registry?: Map<string, HypenModuleDefinition>;
  private dataSourceEntries: Array<{ plugin: DataSourcePlugin; config: unknown }> = [];
  private _stateStore?: StateStore<T>;

  constructor(
    initialState: T,
    options?: { persist?: boolean; version?: number; name?: string },
    registry?: Map<string, HypenModuleDefinition>
  ) {
    this.initialState = initialState;
    this.options = options || {};
    this._registry = registry;
  }

  /**
   * Register a handler for module creation
   */
  onCreated(fn: LifecycleHandler<T>): this {
    this.createdHandler = fn;
    return this;
  }

  /**
   * Register a handler for a specific action.
   * Optionally provide a payload type parameter for typed action payloads.
   *
   * @example
   * ```typescript
   * // Typed payload:
   * .onAction<{ amount: number }>("add", ({ action, state }) => {
   *   action.payload.amount; // fully typed
   * })
   *
   * // Untyped (payload is unknown):
   * .onAction("add", ({ action, state }) => {
   *   action.payload; // unknown
   * })
   * ```
   */
  onAction<P = unknown>(name: string, fn: ActionHandler<T, P>): this {
    this.actionHandlers.set(name, fn as ActionHandler<T, any>);
    return this;
  }

  /**
   * Register a handler that runs every time the module becomes the active
   * route target.
   *
   * Unlike `onCreated`, which only runs once per module instance, `onActivated`
   * runs on **every** mount — the first one (right after `onCreated`) and
   * every subsequent re-entry when a cached module is restored by
   * `ManagedRouter`. Use this hook for data refresh, (re)connecting
   * subscriptions, starting timers, and any "screen became visible" work
   * that should happen on every navigation to this route.
   *
   * @example
   * ```typescript
   * app
   *   .defineState({ items: [], loading: false })
   *   .onActivated(async (state) => {
   *     state.loading = true;
   *     state.items = await fetchItems();
   *     state.loading = false;
   *   });
   * ```
   */
  onActivated(fn: LifecycleHandler<T>): this {
    this.activatedHandler = fn;
    return this;
  }

  /**
   * Register a handler that runs every time the module stops being the
   * active route target.
   *
   * Runs before the module is cached for persistence (when the user
   * navigates to another route) OR before `onDestroyed` if the module is
   * being torn down. Use this for pausing timers, unsubscribing from
   * ephemeral streams, and any "screen became hidden" cleanup.
   */
  onDeactivated(fn: LifecycleHandler<T>): this {
    this.deactivatedHandler = fn;
    return this;
  }

  /**
   * Register a handler for module destruction
   */
  onDestroyed(fn: LifecycleHandler<T>): this {
    this.destroyedHandler = fn;
    return this;
  }

  /**
   * Register a handler for client disconnection
   * Called when client disconnects; session persists for TTL
   * Use this to save state for later restoration
   */
  onDisconnect(fn: DisconnectHandler<T>): this {
    this.disconnectHandler = fn;
    return this;
  }

  /**
   * Register a handler for session reconnection
   * Called when client reconnects with an existing session ID
   * Use restore() to hydrate state from saved data
   */
  onReconnect(fn: ReconnectHandler<T>): this {
    this.reconnectHandler = fn;
    return this;
  }

  /**
   * Register a handler for session expiration
   * Called when TTL expires and client never reconnected
   * Use this to clean up stored state
   */
  onExpire(fn: ExpireHandler): this {
    this.expireHandler = fn;
    return this;
  }

  /**
   * Register an error handler for the module
   * Called when any error occurs in action handlers or lifecycle hooks
   *
   * @example
   * ```typescript
   * app
   *   .defineState({ count: 0 })
   *   .onAction("increment", ({ state }) => {
   *     if (state.count > 100) throw new Error("Count too high");
   *     state.count += 1;
   *   })
   *   .onError(({ error, actionName, state }) => {
   *     console.error(`Error in ${actionName}:`, error.message);
   *     // Optionally recover
   *     if (error.message.includes("too high")) {
   *       return { handled: true }; // Don't propagate
   *     }
   *     // Or retry
   *     // return { retry: true };
   *   })
   *   .build();
   * ```
   *
   * @param fn - Error handler function
   * @returns Builder for chaining
   */
  onError(fn: ErrorHandler<T>): this {
    this.errorHandler = fn;
    return this;
  }

  /**
   * Attach a persistent state store.
   * The store handles save/restore lifecycle automatically.
   *
   * @example
   * ```typescript
   * import { durableObjectStore, withKey } from "@hypen-space/cf";
   *
   * app
   *   .defineState({ user: null, todos: [] }, { name: "TodoList" })
   *   .persist(durableObjectStore(withKey(state => state.user?.id)))
   *   .build();
   * ```
   */
  persist(store: StateStore<T>): this {
    this._stateStore = store;
    return this;
  }

  /**
   * Register a data source plugin for live database subscriptions.
   *
   * @example
   * ```typescript
   * import { SpacetimeDBPlugin } from "@hypen-space/plugin-spacetimedb";
   *
   * export default app
   *   .defineState({ messageText: "" })
   *   .useDataSource(new SpacetimeDBPlugin(), {
   *     uri: "ws://localhost:3000",
   *     moduleName: "chat",
   *     tables: ["user", "message"],
   *   })
   *   .onAction("sendMessage", async ({ state, dataSources }) => {
   *     await dataSources.spacetime.sendMessage(state.messageText);
   *     state.messageText = "";
   *   })
   *   .build();
   * ```
   *
   * In Hypen DSL, bind to data source tables with `@provider.table`:
   * ```hypen
   * ForEach(items: @spacetime.message, key: "id") {
   *   Text("@{item.text}")
   * }
   * ```
   */
  useDataSource<C>(plugin: DataSourcePlugin<C>, config: C): this {
    this.dataSourceEntries.push({ plugin: plugin as DataSourcePlugin, config });
    return this;
  }

  /**
   * Define the component's UI template inline (single-file component).
   *
   * Use with the `hypen` tagged template literal and binding proxies:
   *
   * @example
   * ```typescript
   * import { app, hypen, state } from "@hypen-space/core";
   *
   * export default app
   *   .defineState({ count: 0 })
   *   .onAction("increment", ({ state }) => {
   *     state.count += 1;
   *   })
   *   .ui(hypen`
   *     Column {
   *       Text("Count: @{state.count}")
   *       Button { Text("+") }
   *         .onClick("@actions.increment")
   *     }
   *   `);
   * ```
   *
   * @param template - The Hypen DSL template string
   * @returns The built module definition (calls build() internally)
   */
  ui(template: string): HypenModuleDefinition<T> {
    this.template = template;
    return this.build();
  }

  /**
   * Load a UI template from a .hypen file on disk.
   *
   * @example
   * ```typescript
   * import { app } from "@hypen-space/core";
   *
   * export default app
   *   .defineState({ count: 0 })
   *   .onAction("increment", ({ state }) => { state.count += 1; })
   *   .uiFile("./counter.hypen");
   * ```
   *
   * @param path - Path to a .hypen template file
   * @returns The built module definition (calls build() internally)
   */
  uiFile(path: string): HypenModuleDefinition<T> {
    const fs = require("fs");
    this.template = fs.readFileSync(path, "utf-8").trim();
    return this.build();
  }

  /**
   * Build the module definition
   */
  build(): HypenModuleDefinition<T> {
    // Safe way to get keys from initialState
    const stateKeys = this.initialState !== null && typeof this.initialState === 'object'
      ? Object.keys(this.initialState)
      : [];

    const definition: HypenModuleDefinition<T> = {
      name: this.options.name,
      actions: Array.from(this.actionHandlers.keys()),
      stateKeys,
      persist: this.options.persist,
      version: this.options.version,
      initialState: this.initialState,
      template: this.template,
      dataSources: this.dataSourceEntries.length > 0 ? this.dataSourceEntries : undefined,
      stateStore: this._stateStore,
      handlers: {
        onCreated: this.createdHandler,
        onActivated: this.activatedHandler,
        onDeactivated: this.deactivatedHandler,
        onAction: this.actionHandlers,
        onDestroyed: this.destroyedHandler,
        onDisconnect: this.disconnectHandler,
        onReconnect: this.reconnectHandler,
        onExpire: this.expireHandler,
        onError: this.errorHandler,
      },
    };

    // Auto-register in the app registry when the module has a name
    if (this.options.name && this._registry) {
      this._registry.set(this.options.name, definition as HypenModuleDefinition);
    }

    return definition;
  }
}

/**
 * Hypen App API — singleton factory and component registry.
 *
 * Modules built with a `name` are automatically registered here.
 * Consumers (ManagedRouter, RemoteServer, ComponentResolver) read from this
 * registry instead of requiring a separate ModuleRegistry instance.
 */
export class HypenApp {
  /** @internal */
  readonly _registry = new Map<string, HypenModuleDefinition>();

  /**
   * Define the initial state for a module
   */
  defineState<T>(
    initial: T,
    options?: { persist?: boolean; version?: number; name?: string }
  ): HypenAppBuilder<T> {
    return new HypenAppBuilder(initial, options, this._registry);
  }

  /**
   * Convenience: start a module builder with a name pre-set.
   *
   * @example
   * ```typescript
   * export default app
   *   .module("Settings")
   *   .defineState({ theme: "dark" })
   *   .ui(hypen`...`);
   * ```
   */
  module(name: string) {
    const registry = this._registry;
    return {
      defineState: <T>(
        initial: T,
        options?: { persist?: boolean; version?: number }
      ): HypenAppBuilder<T> => {
        return new HypenAppBuilder(initial, { ...options, name }, registry);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Registry API
  // ---------------------------------------------------------------------------

  /**
   * Get a registered module definition by component name.
   */
  get(name: string): HypenModuleDefinition | undefined {
    return this._registry.get(name);
  }

  /**
   * Check if a module definition is registered.
   */
  has(name: string): boolean {
    return this._registry.has(name);
  }

  /**
   * Read-only view of all registered component definitions.
   */
  get components(): ReadonlyMap<string, HypenModuleDefinition> {
    return this._registry;
  }

  /**
   * Get all registered component names.
   */
  getNames(): string[] {
    return Array.from(this._registry.keys());
  }

  /**
   * Number of registered definitions.
   */
  get size(): number {
    return this._registry.size;
  }

  /**
   * Unregister a module definition.
   */
  unregister(name: string): void {
    this._registry.delete(name);
  }

  /**
   * Clear all registered definitions.
   */
  clear(): void {
    this._registry.clear();
  }
}

/**
 * The main app instance for creating modules
 */
export const app = new HypenApp();

/**
 * Module Instance - manages a running module with typed state
 */
export class HypenModuleInstance<T extends object = any> {
  private engine: IEngine;
  private definition: HypenModuleDefinition<T>;
  private state: T;
  private isDestroyed = false;
  /**
   * Device Capability Protocol identity (RFC 001 §2.7): an opaque,
   * connection-local instance id that is never reassigned, and an activation
   * counter incremented on every `activate()`. Together they form the owner
   * of every device request this module issues; deactivation sweeps exactly
   * that `{instance, activation}` pair, destruction sweeps the instance.
   */
  readonly deviceInstanceId: string;
  private activationId = 0;
  private deviceBroker: DevicePlane | null = null;
  /**
   * > 0 while a dispatch replayed from another session (syncActions) is
   * running synchronously inside this instance. `createGlobalContextAPI`
   * captures it at construction, so the replay firewall survives `await`.
   */
  private replayDepth = 0;
  /**
   * True when the module is currently the active route target (i.e.
   * `onActivated` has fired more recently than `onDeactivated`).
   * Used to make `activate()` / `deactivate()` idempotent so the
   * `ManagedRouter` can call them safely regardless of state.
   */
  private isActive = false;
  private router: HypenRouter | null;
  private globalContext?: HypenGlobalContext;
  private stateChangeCallbacks: Array<() => void> = [];
  private dataSourceManager?: DataSourceManager;
  private dataSourceAccessor: DataSourceAccessor = {};
  private stateStore?: StateStore<T>;
  private currentPersistKey: string | null = null;
  private persistDebounceTimer: any;
  private sessionId: string;
  /**
   * Lowercase name used to address this module in the engine. Empty string
   * for anonymous modules (which back the engine's primary module slot).
   */
  private moduleKey: string = "";
  /**
   * Pending transaction-scoped animation stamp (Option D cheap subset).
   *
   * Set from `Action.animate` just before an action handler is invoked and
   * consumed by the FIRST observable-state flush that reaches
   * `updateStateSparse` afterwards — that flush passes the stamp's spec as
   * the engine's `animation` argument and clears it, so any later flush in
   * the same handler is unstamped. See the clearing rules where this is
   * written.
   *
   * The spec is wrapped in a unique token object PER DISPATCH: all
   * set/compare/clear operations use token identity, never spec value
   * identity — two dispatches stamping the same curve string (`"spring"`)
   * must not be able to clear each other's pending stamp.
   */
  private pendingAnimation: { spec: unknown } | null = null;

  constructor(
    engine: IEngine,
    definition: HypenModuleDefinition<T>,
    router?: HypenRouter | null,
    globalContext?: HypenGlobalContext,
    sessionId?: string
  ) {
    this.engine = engine;
    this.definition = definition;
    this.router = router ?? null;
    // Always-present context (RFC 001 §6 Phase 2): a module constructed
    // without a shared global context still gets a private one, so handler
    // `context` is never undefined and `context.device` always exists.
    this.globalContext = globalContext ?? new HypenGlobalContext();
    this.sessionId = sessionId ?? crypto.randomUUID();
    this.stateStore = definition.stateStore;
    // Opaque and random: sent to the client in every request owner, so it
    // must reveal neither module names nor how many instances this process
    // has created (RFC 001 §2.7 "opaque connection-local ids").
    this.deviceInstanceId = `mi-${crypto.randomUUID()}`;

    // Lowercase module name — used as the engine-side scope key. Empty for
    // anonymous modules (which become the engine's primary module).
    const moduleKey = (definition.name || "").toLowerCase();
    this.moduleKey = moduleKey;

    // Create observable state that forwards changed paths to the engine.
    // Paths are passed through raw — the engine handles module scoping via
    // the IR's `module_scope` field derived from `module <Name> { ... }` in
    // the DSL.
    this.state = createObservableState<T>(definition.initialState as T & object, {
      onChange: (change: StateChange) => {
        // Consume the pending transaction-animation stamp (Option D): the
        // FIRST flush after an action handler starts carries it to the
        // engine (which emits a leading batchAnimation patch), and it is
        // cleared here so every subsequent flush is unstamped.
        const pending = this.pendingAnimation;
        this.pendingAnimation = null;
        this.engine.updateStateSparse(
          moduleKey || null,
          change.paths,
          change.newValues,
          pending ? pending.spec : undefined
        );
        this.stateChangeCallbacks.forEach(cb => cb());
        this.persistIfNeeded();
      },
    });

    // Register the module with the engine. Named modules go into the
    // secondary `engine.modules` slot under their lowercase name; anonymous
    // modules become the engine's primary module.
    const snapshot = getStateSnapshot(this.state);
    if (moduleKey) {
      this.engine.registerModule(
        moduleKey,
        definition.actions,
        definition.stateKeys,
        snapshot
      );
    } else {
      this.engine.setModule(
        "AnonymousModule",
        definition.actions,
        definition.stateKeys,
        snapshot
      );
    }

    // Register action handlers with flexible parameter support
    for (const [actionName, handler] of definition.handlers.onAction) {
      log.debug(`Registering action handler: ${actionName} for module ${definition.name}`);
      this.engine.onAction(`__hypen_scoped:${this.moduleKey}:${actionName}`, async (action: Action) => {
        log.debug(`Action handler fired: ${actionName}`, action);

        const actionCtx: ActionContext = {
          name: actionName,
          payload: action.payload,
          sender: action.sender,
        };

        const context: GlobalContext | undefined = this.globalContext
          ? this.createGlobalContextAPI()
          : undefined;
        // Handler scope (RFC 001 §2.4): unary device requests still pending
        // when this handler settles are cancelled, and results it received
        // stop counting toward the connection quota only then.
        context?.device.beginHandlerScope();

        // Transaction-scoped animation (Option D cheap subset): the action's
        // `animate` stamp becomes pending BEFORE the handler runs, so the
        // first observable flush it produces is stamped. Wrapped in a fresh
        // token object so clears compare by dispatch identity (see
        // pendingAnimation).
        const stamp = action.animate ?? null;
        const token = stamp != null ? { spec: stamp } : null;
        if (token) {
          // Drain any PRE-QUEUED observable flush synchronously first (e.g.
          // a `.bind` mutation earlier in this same task): those mutations
          // predate this dispatch and must go out UNSTAMPED — and if they
          // came from an earlier stamped dispatch in the same task, they
          // flush here still carrying THAT dispatch's pending stamp.
          (this.state as { __flushNow?: () => void }).__flushNow?.();
          // Overwrite semantics: if an earlier dispatch's stamp is STILL
          // pending here (its handler never mutated, so the drain above had
          // nothing to flush), the LAST stamped dispatch wins — its spec
          // replaces the unconsumed one.
          this.pendingAnimation = token;
        }

        // Use Result type for error handling. Invoke WITHOUT awaiting yet:
        // the handler's synchronous portion runs inside this call (its
        // mutations schedule the observable flush microtask first), and the
        // clear below must be queued AFTER that but BEFORE any awaited
        // continuation of the handler resumes.
        const resultPromise = this.executeAction(actionName, handler, {
          action: actionCtx,
          state: this.state,
          context: context!,
          dataSources: this.dataSourceAccessor,
        });

        if (token) {
          // Clearing rules for the pending stamp (all compares are TOKEN
          // identity — another dispatch's stamp is never cleared here):
          // 1. Consumed by the first flush (see the onChange callback) — a
          //    handler that mutates synchronously stamps exactly one flush,
          //    because that flush's microtask was queued during the handler
          //    call, i.e. before this clear.
          // 2. Cleared one microtask after the handler's SYNCHRONOUS portion
          //    — so mutations after an `await` are unstamped: the awaited
          //    continuation (and the flush it schedules) runs after this
          //    microtask has already cleared the stamp.
          // 3. A handler that never mutates schedules no flush, so this
          //    clear (which also covers handler completion for the sync
          //    case) leaves nothing pending.
          queueMicrotask(() => {
            if (this.pendingAnimation === token) {
              this.pendingAnimation = null;
            }
          });
        }

        const result = await resultPromise;
        context?.device.endHandlerScope();

        // Belt-and-braces for handler completion (async handlers outlive the
        // microtask above only via awaits, whose mutations must be unstamped
        // anyway): never let this action's stamp leak past its own run.
        if (token && this.pendingAnimation === token) {
          this.pendingAnimation = null;
        }

        if (!result.ok) {
          const shouldRethrow = await this.handleError(result.error, { actionName });
          if (shouldRethrow) {
            throw result.error;
          }
        } else {
          log.debug(`Action handler completed: ${actionName}`);
        }
      });
    }

    // Auto-register __hypen_bind for .bind() two-way binding support
    this.engine.onAction(`__hypen_scoped:${this.moduleKey}:${"__hypen_bind"}`, (action: Action) => {
      if (this.isDestroyed) return;
      const payload = action.payload as { path?: string; value?: unknown } | null;
      if (!payload?.path) return;

      const segments = payload.path.split(".");
      let target: any = this.state;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        target = target?.[seg];
        if (target == null) return;
      }
      const lastSeg = segments[segments.length - 1]!;
      target[lastSeg] = payload.value;
    });

    // Auto-register the two reserved drag-and-drop outcome actions
    // (hypen-web/docs/dnd.md). Both MUST write through
    // `this.state` (the Proxy) so dependency tracking, persistence, and
    // Remote UI streaming all fire — never through engine state directly.
    // Malformed payloads warn and degrade to a no-op (repo rule).
    //
    // The engine resolves the owning module before invoking this scoped handler.
    this.engine.onAction(`__hypen_scoped:${this.moduleKey}:${DND_REORDER_ACTION}`, (action: Action) => {
      if (this.isDestroyed) return;
      const payload = action.payload as Record<string, unknown> | null | undefined;
      if (!payload || typeof payload !== "object") {
        log.warn(`${DND_REORDER_ACTION}: missing payload`);
        return;
      }
      // `path` is shorthand for fromPath == toPath.
      const fromPath =
        typeof payload.fromPath === "string"
          ? payload.fromPath
          : typeof payload.path === "string"
            ? payload.path
            : null;
      const toPath = typeof payload.toPath === "string" ? payload.toPath : fromPath;
      const { from, to } = payload;
      if (fromPath === null || toPath === null || typeof from !== "number" || typeof to !== "number") {
        log.warn(`${DND_REORDER_ACTION}: malformed payload`, payload);
        return;
      }
      if (!applyPathMove(this.state, fromPath, from, toPath, to)) {
        log.warn(
          `${DND_REORDER_ACTION}: no-op — "${fromPath}"[${from}] → "${toPath}"[${to}] does not resolve to arrays / in-range index`
        );
      }
    });

    this.engine.onAction(`__hypen_scoped:${this.moduleKey}:${DND_PIN_ACTION}`, (action: Action) => {
      if (this.isDestroyed) return;
      const payload = action.payload as Record<string, unknown> | null | undefined;
      if (!payload || typeof payload !== "object") {
        log.warn(`${DND_PIN_ACTION}: missing payload`);
        return;
      }
      const { path, x, y } = payload;
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        typeof y !== "number" ||
        !Number.isFinite(y)
      ) {
        log.warn(`${DND_PIN_ACTION}: malformed payload`, payload);
        return;
      }
      const xKey = typeof payload.xKey === "string" && payload.xKey.length > 0 ? payload.xKey : "x";
      const yKey = typeof payload.yKey === "string" && payload.yKey.length > 0 ? payload.yKey : "y";
      // Two path sets, batched into one observable flush. Missing
      // intermediate objects auto-vivify (mirrors `portable::path_set`), so
      // the first pin of a reserved-mode key creates `__dnd.<group>.<key>`.
      batchStateUpdates(this.state, () => {
        this.setStatePathVivify(`${path}.${xKey}`, x);
        this.setStatePathVivify(`${path}.${yKey}`, y);
      });
    });

    // Call onCreated — store the promise so callers can await initialization
    this._readyPromise = this.callCreatedHandler();
  }

  /**
   * Set a dotted state path through the Proxy, creating missing
   * intermediate objects on the way down (`portable::path_set` semantics).
   * A primitive standing where a container is needed cannot be descended
   * into: warn and leave state untouched.
   */
  private setStatePathVivify(path: string, value: unknown): void {
    const segments = path.split(".");
    let target: any = this.state;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      let next = target[seg];
      if (next === null || next === undefined) {
        target[seg] = {};
        next = target[seg];
      } else if (typeof next !== "object") {
        log.warn(`cannot set "${path}": "${segments.slice(0, i + 1).join(".")}" is not an object`);
        return;
      }
      target = next;
    }
    target[segments[segments.length - 1]!] = value;
  }

  /** Promise that resolves when onCreated handler has completed */
  private _readyPromise: Promise<void> = Promise.resolve();

  /**
   * Wait for the module's onCreated handler to complete.
   * Call this before renderSource to ensure state is fully initialized.
   */
  async waitForReady(): Promise<void> {
    await this._readyPromise;
  }

  /**
   * Mark the module as the active route target and fire `onActivated`.
   *
   * Idempotent: calling `activate()` on an already-active module is a
   * no-op. Internally awaits `waitForReady()` so that `onCreated` always
   * runs to completion before `onActivated` fires, regardless of who
   * calls this method and when.
   *
   * Called by `ManagedRouter` on every route mount — both fresh
   * constructions and re-mounts from the persistence cache.
   */
  async activate(): Promise<void> {
    if (this.isDestroyed || this.isActive) return;
    // Ensure onCreated finishes before onActivated — critical on fresh
    // mounts where the constructor kicks off onCreated asynchronously.
    await this._readyPromise;
    if (this.isDestroyed || this.isActive) return;
    this.isActive = true;
    // Activation authority becomes available BEFORE onActivated runs
    // (RFC 001 §2.7): a fresh activation id owns this activation's work,
    // registered with the connection's broker (which only admits requests
    // for a module instance's live activation).
    this.activationId += 1;
    this.deviceBroker?.ownerActivated(this.deviceInstanceId, this.activationId);
    if (this.definition.handlers.onActivated) {
      const context = this.globalContext ? this.createGlobalContextAPI() : undefined;
      context?.device.beginHandlerScope();
      try {
        await this.definition.handlers.onActivated(this.state, context);
      } catch (e) {
        const error = e instanceof HypenError ? e : new ActionError("onActivated", e);
        const shouldRethrow = await this.handleError(error, { lifecycle: "activated" });
        if (shouldRethrow) {
          throw error;
        }
      } finally {
        context?.device.endHandlerScope();
      }
    }
  }

  /**
   * Mark the module as no longer the active route target and fire
   * `onDeactivated`.
   *
   * Idempotent: calling `deactivate()` on an inactive module is a no-op.
   * Called by `ManagedRouter` before persisting a module for later reuse
   * OR before destroying it.
   */
  async deactivate(): Promise<void> {
    if (this.isDestroyed || !this.isActive) return;
    this.isActive = false;
    // Authority is revoked BEFORE onDeactivated executes (RFC 001 §2.7):
    // every device request owned by this exact activation is cancelled.
    this.deviceBroker?.ownerDeactivated(this.deviceInstanceId, this.activationId);
    if (this.definition.handlers.onDeactivated) {
      const context = this.globalContext ? this.createGlobalContextAPI() : undefined;
      try {
        await this.definition.handlers.onDeactivated(this.state, context);
      } catch (e) {
        const error = e instanceof HypenError ? e : new ActionError("onDeactivated", e);
        const shouldRethrow = await this.handleError(error, { lifecycle: "deactivated" });
        if (shouldRethrow) {
          throw error;
        }
      }
    }
  }

  /** True once `destroy()` has run; a destroyed instance is never reused. */
  get destroyed(): boolean {
    return this.isDestroyed;
  }

  /**
   * Bind this instance to a connection's device plane (RFC 001 §2.7). The
   * broker is the connection's; the instance only contributes ownership: a
   * currently active instance registers its live activation right away.
   */
  attachDevice(plane: DevicePlane | null): void {
    this.deviceBroker = plane;
    if (plane && this.isActive && !this.isDestroyed) {
      plane.ownerActivated(this.deviceInstanceId, this.activationId);
    }
  }

  /**
   * Run `fn` as a replayed dispatch (syncActions fan-out). Any handler
   * context constructed synchronously inside carries replay provenance, so
   * its `context.device` refuses to open requests — even after `await`.
   */
  runReplayed<R>(fn: () => R): R {
    this.replayDepth += 1;
    try {
      return fn();
    } finally {
      this.replayDepth -= 1;
    }
  }

  /**
   * Build the device surface for a handler context constructed right now.
   * Owner and provenance are fixed at this moment (RFC 001 §4/§7).
   */
  private createDeviceContext(): DeviceContext {
    const provenance = this.replayDepth > 0 ? "replay" : "origin";
    const owner = {
      moduleInstanceId: this.deviceInstanceId,
      activationId: this.activationId,
    };
    if (!this.deviceBroker) {
      return new DeviceContext(null, owner, provenance, "device-disabled");
    }
    if (!this.isActive) {
      // Calls from onCreated before the first activation, or from
      // deactivation/destruction handlers, return unavailable immediately
      // rather than waiting for activation and deadlocking (RFC 001 §2.7).
      return new DeviceContext(this.deviceBroker, owner, provenance, "owner-inactive");
    }
    // The captured activation stays authoritative only while it is the live
    // one: an `await` resuming after deactivation cannot start new device
    // work (RFC 001 §2.7).
    const activationId = this.activationId;
    const ownerLive = () =>
      !this.isDestroyed && this.isActive && this.activationId === activationId;
    return new DeviceContext(this.deviceBroker, owner, provenance, null, ownerLive);
  }

  /**
   * True while this instance owns live `background`-lifetime device work
   * (RFC 001 §2.7). Such an instance is pinned: `ManagedRouter` skips it
   * when evicting persisted modules, within a hard pin cap.
   */
  get hasLiveBackgroundDeviceWork(): boolean {
    if (this.isDestroyed || !this.deviceBroker) return false;
    return this.deviceBroker.hasBackgroundWork(this.deviceInstanceId);
  }

  /**
   * Create the global context API for this module
   */
  private createGlobalContextAPI(): GlobalContext {
    if (!this.globalContext) {
      throw new Error("Global context not available");
    }

    const ctx = this.globalContext;
    const api: GlobalContext = {
      getModule: (id: string) => ctx.getModule(id),
      hasModule: (id: string) => ctx.hasModule(id),
      getModuleIds: () => ctx.getModuleIds(),
      getGlobalState: () => ctx.getGlobalState(),
      emit: (event: string, payload?: any) => ctx.emit(event, payload),
      on: (event: string, handler: (payload?: any) => void) =>
        ctx.on(event, handler),
      router: this.router,
      device: this.createDeviceContext(),
    };

    // Expose hypen engine for built-in components (if available)
    const ctxRecord = ctx as unknown as Record<string, unknown>;
    if (ctxRecord.__hypenEngine) {
      (api as Record<string, unknown>).__hypenEngine = ctxRecord.__hypenEngine;
    }

    return api;
  }

  /**
   * Execute an action handler with Result-based error handling
   * Handles both synchronous throws and async rejections
   */
  private async executeAction(
    actionName: string,
    handler: ActionHandler<T, any>,
    ctx: ActionHandlerContext<T>
  ): Promise<Result<void, ActionError>> {
    try {
      // Wrap in try-catch to handle synchronous throws
      const result = handler(ctx);
      // Await in case handler returns a promise
      await result;
      return Ok(undefined);
    } catch (e) {
      return Err(new ActionError(actionName, e));
    }
  }

  /**
   * Handle an error with module-level error handler support
   * Falls back to default behavior (emit + log) if no handler or handler doesn't suppress
   * @returns true if the error should be rethrown
   */
  private async handleError(
    error: HypenError,
    context: { actionName?: string; lifecycle?: ErrorContext<T>["lifecycle"] }
  ): Promise<boolean> {
    const errorCtx: ErrorContext<T> = {
      error,
      state: this.state,
      actionName: context.actionName,
      lifecycle: context.lifecycle,
    };

    // Call module-level error handler if defined
    if (this.definition.handlers.onError) {
      try {
        const result = await this.definition.handlers.onError(errorCtx);

        // Check if error was handled
        if (result && typeof result === "object") {
          if ("handled" in result && result.handled) {
            // Error was handled, skip default behavior
            return false;
          }
          if ("rethrow" in result && result.rethrow) {
            // Signal caller to rethrow
            return true;
          }
          // Note: 'retry' would need to be handled at the action execution level
          // For now, we just continue with default behavior
        }
      } catch (handlerError) {
        // Error in error handler - log and continue with default behavior
        log.error("Error in onError handler:", handlerError);
      }
    }

    // Default behavior: emit to global context and log
    if (this.globalContext) {
      const eventContext = context.actionName
        ? `action:${context.actionName}`
        : context.lifecycle
          ? `lifecycle:${context.lifecycle}`
          : "unknown";

      this.globalContext.emit("error", {
        message: error.message,
        error,
        context: eventContext,
      });
    }

    log.error(
      `${context.actionName ? `Action "${context.actionName}"` : `Lifecycle "${context.lifecycle}"`} error:`,
      error
    );

    return false;
  }

  /**
   * Re-evaluate the persistence key and debounce saves on state mutation.
   * Handles key transitions (null->value, value->null, value->different value).
   */
  private persistIfNeeded(): void {
    if (!this.stateStore) return;

    const store = this.stateStore;
    const newKey = store.resolveKey(
      this.state,
      this.definition.name || "AnonymousModule",
      this.sessionId
    );

    // Key transition: null -> value (e.g. login)
    if (newKey && !this.currentPersistKey) {
      this.activatePersistence(newKey);
      return;
    }

    // Key transition: value -> null (e.g. logout)
    if (!newKey && this.currentPersistKey) {
      this.currentPersistKey = null;
      return; // stop persisting, but don't delete stored data
    }

    // Key transition: value -> different value (e.g. account switch)
    if (newKey && newKey !== this.currentPersistKey) {
      this.activatePersistence(newKey);
      return;
    }

    // No key = no persistence
    if (!this.currentPersistKey) return;

    // Same key — debounced save
    clearTimeout(this.persistDebounceTimer);
    this.persistDebounceTimer = setTimeout(() => {
      const snapshot = getStateSnapshot(this.state);
      store.save(this.currentPersistKey!, snapshot);
    }, 50);
  }

  /**
   * Activate persistence for the given key: load stored state and merge.
   */
  private async activatePersistence(key: string): Promise<void> {
    this.currentPersistKey = key;
    const stored = await this.stateStore!.load(key);
    if (stored) {
      // Merge stored over initialState, then apply to live state
      const merged = { ...this.definition.initialState, ...stored };
      Object.assign(this.state, merged); // triggers re-render via proxy
    } else {
      // First time with this key — save current state
      const snapshot = getStateSnapshot(this.state);
      await this.stateStore!.save(key, snapshot);
    }
  }

  /**
   * Call the onCreated handler and connect data source plugins
   */
  private async callCreatedHandler(): Promise<void> {
    // Load persisted state before anything else
    if (this.stateStore) {
      const key = this.stateStore.resolveKey(
        this.state,
        this.definition.name || "AnonymousModule",
        this.sessionId
      );
      if (key) {
        this.currentPersistKey = key;
        const stored = await this.stateStore.load(key);
        if (stored) {
          const merged = { ...this.definition.initialState, ...stored };
          Object.assign(this.state, merged);
        }
      }
    }

    // Initialize data source plugins if any are registered
    if (this.definition.dataSources?.length) {
      // The engine must implement IDataSourceEngine methods
      const dsEngine = this.engine as unknown as IDataSourceEngine;
      this.dataSourceManager = new DataSourceManager(dsEngine);

      for (const { plugin, config } of this.definition.dataSources) {
        try {
          await this.dataSourceManager.use(plugin, config);
          // Wrap plugin in a Proxy so unknown method calls forward to plugin.call():
          //   dataSources.spacetime.sendMessage(text) → plugin.call("sendMessage", text)
          this.dataSourceAccessor[plugin.name] = new Proxy(plugin, {
            get(target, prop) {
              if (typeof prop === 'string' && !(prop in target)) {
                return (...args: unknown[]) => target.call(prop, ...args);
              }
              return (target as unknown as Record<string | symbol, unknown>)[prop];
            },
          }) as typeof plugin & Record<string, (...args: unknown[]) => Promise<unknown>>;
        } catch (e) {
          log.error(`Failed to connect data source "${plugin.name}":`, e);
        }
      }
    }

    if (this.definition.handlers.onCreated) {
      const context = this.globalContext ? this.createGlobalContextAPI() : undefined;
      try {
        await this.definition.handlers.onCreated(this.state, context);
      } catch (e) {
        const error = e instanceof HypenError ? e : new ActionError("onCreated", e);
        const shouldRethrow = await this.handleError(error, { lifecycle: "created" });
        if (shouldRethrow) {
          throw error;
        }
      }
    }
  }

  /**
   * Register a callback to be notified when state changes
   */
  onStateChange(callback: () => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  /**
   * Destroy the module instance and disconnect all data source plugins
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;

    // If this module is still marked as active (e.g. destroy() was called
    // without a preceding deactivate()), fire onDeactivated first so the
    // lifecycle order is always: ...onActivated → onDeactivated → onDestroyed.
    if (this.isActive) {
      await this.deactivate();
    }

    // Destruction sweeps every device request this instance owns, including
    // background-lifetime work that deactivation deliberately spared
    // (RFC 001 §2.7).
    this.deviceBroker?.ownerDestroyed(this.deviceInstanceId);

    // Flush any pending persistence writes before shutdown
    if (this.currentPersistKey && this.stateStore) {
      clearTimeout(this.persistDebounceTimer);
      const snapshot = getStateSnapshot(this.state);
      await this.stateStore.save(this.currentPersistKey, snapshot);
    }

    // Disconnect all data source plugins
    if (this.dataSourceManager) {
      try {
        await this.dataSourceManager.disconnectAll();
      } catch (e) {
        log.error("Error disconnecting data sources:", e);
      }
      this.dataSourceManager = undefined;
      this.dataSourceAccessor = {};
    }

    if (this.definition.handlers.onDestroyed) {
      try {
        await this.definition.handlers.onDestroyed(this.state);
      } catch (e) {
        const error = e instanceof HypenError ? e : new ActionError("onDestroyed", e);
        const shouldRethrow = await this.handleError(error, { lifecycle: "destroyed" });
        if (shouldRethrow) {
          throw error;
        }
      }
    }

    this.isDestroyed = true;
  }

  /**
   * Get the current state (returns a snapshot)
   */
  getState(): T {
    return getStateSnapshot(this.state);
  }

  /**
   * Get the live observable state
   */
  getLiveState(): T {
    return this.state;
  }

  /**
   * Update state directly (merges with existing state)
   */
  updateState(patch: Partial<T>): void {
    Object.assign(this.state, patch);
  }
}
