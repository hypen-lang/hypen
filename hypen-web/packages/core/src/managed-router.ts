/**
 * Managed Router — orchestrates module mount/unmount on route changes.
 *
 * When the router navigates to a route:
 * 1. Deactivates and unmounts the previous module (either persisting it for
 *    later reuse or destroying it).
 * 2. Mounts the new module (creating it fresh or restoring from cache) and
 *    activates it.
 *
 * Module names are used as state prefixes (lowercased) for isolation.
 *
 * ## Persistence (default: on for module-backed routes)
 *
 * By default, any route whose `component` resolves to a registered module
 * definition (or provides one inline via `route.module`) has its module
 * instance **persisted** across navigations. This preserves module state
 * (e.g. fetched data, form inputs, scroll position in state) so that
 * navigating away and back doesn't re-trigger the initial "loading" state
 * that usually lives in `onCreated`.
 *
 * Opt out by setting `persist: false` on the module definition. Routes
 * without a module definition are unchanged — they have nothing to persist.
 *
 * ## Persistence cache bound (LRU)
 *
 * The persisted-module cache is an insertion-ordered LRU with a default
 * cap of `DEFAULT_MAX_PERSISTED_MODULES` (= 10). Persisting a module
 * past the cap evicts the least-recently-persisted entry and tears it
 * down via `instance.destroy()` + `unregisterModule()` — the same path a
 * `persist: false` module takes on unmount. Restoring from the cache
 * counts as a touch (the entry is removed on mount and re-inserted on
 * next unmount, placing it at the MRU end).
 *
 * The cap matches the engine's `DEFAULT_ROUTER_CACHE_SIZE` for the
 * Router IR subtree cache, so SDK-level module retention and
 * engine-level DOM-subtree retention stay in lockstep by default.
 * Override via the `maxPersistedModules` constructor option. Pass
 * `Infinity` to disable eviction (only advisable for bounded route
 * sets — otherwise a long session will leak).
 *
 * ## Lifecycle on navigation
 *
 * First visit to a route:
 *   `construct → onCreated → onActivated`
 * Navigate away:
 *   `onDeactivated` (then either persist in cache OR `onDestroyed`)
 * Revisit (persisted):
 *   `onActivated` (only — `onCreated` does not re-run)
 *
 * Use `onActivated` for per-navigation side effects like refreshing data;
 * use `onCreated` for one-time module setup.
 */

import type { IEngine, HypenModuleDefinition } from "./app.js";
import { HypenModuleInstance, HypenApp } from "./app.js";
import type { HypenRouter, RouteState } from "./router.js";
import type { HypenGlobalContext } from "./context.js";
import { createLogger } from "./logger.js";
import { MAX_BACKGROUND_PINNED_MODULES } from "./remote/device/constants.js";

const log = createLogger("ManagedRouter");

/**
 * Default upper bound on `persistedModules`. Mirrors
 * `DEFAULT_ROUTER_CACHE_SIZE` in the engine's Router IR node so the SDK
 * module cache and the engine subtree cache evict in lockstep.
 */
export const DEFAULT_MAX_PERSISTED_MODULES = 10;

export interface RouteDefinition {
  /** Route path pattern (e.g., "/", "/profile/:id") */
  path: string;
  /** Component name — used to look up in app registry */
  component: string;
  /** Inline module definition (alternative to registry lookup) */
  module?: HypenModuleDefinition;
}

export interface ManagedRouterOptions {
  /**
   * Maximum number of persisted module instances retained across
   * navigations. When persistence would push the cache past this cap,
   * the least-recently-persisted entry is destroyed. Defaults to
   * `DEFAULT_MAX_PERSISTED_MODULES`. Pass `Infinity` to disable
   * eviction.
   */
  maxPersistedModules?: number;
  /**
   * Hard cap on persisted modules the LRU keeps past `maxPersistedModules`
   * because they own live `background` device work (RFC 001 §2.7). Beyond
   * it, the oldest pinned module is evicted anyway (destruction cancels its
   * background work). Defaults to `MAX_BACKGROUND_PINNED_MODULES` (2).
   */
  maxPinnedModules?: number;
  /**
   * Called for every freshly constructed route module before it activates,
   * so the host can bind it to the connection's device broker (RFC 001
   * §2.7) — `RemoteSession` uses this to give routed modules device access.
   */
  onModuleCreated?: (instance: HypenModuleInstance) => void;
}

export class ManagedRouter {
  private router: HypenRouter;
  private engine: IEngine;
  private registry: HypenApp;
  private globalContext: HypenGlobalContext;
  private routes: RouteDefinition[] = [];
  private activeModule: HypenModuleInstance | null = null;
  private activeRoute: RouteDefinition | null = null;
  private unsubscribe: (() => void) | null = null;
  /**
   * Cached instances for module-backed routes, keyed by the lowercase
   * module id. Entries are populated on unmount (when `persist` is truthy)
   * and consulted on mount to restore state across navigations.
   *
   * Persistence is the default for any route whose `component` or `module`
   * resolves to a module definition; opt out by setting `persist: false`
   * on the definition.
   *
   * Bounded by `maxPersistedModules`. Map insertion order drives LRU
   * eviction: restoring from the cache removes the entry (so the next
   * persist re-inserts it at the MRU end), and persisting past the cap
   * destroys the oldest entry.
   */
  private persistedModules = new Map<string, HypenModuleInstance>();
  /**
   * Every instance this router constructed that may still be live (active,
   * persisted, or mid-transition between the two). Each destroy path
   * (`unmountActive` without persistence, LRU eviction, `stop()`) removes
   * its instance, so destroyed modules — their state, handlers and engine
   * references — are never retained for the connection's lifetime.
   */
  private createdInstances = new Set<HypenModuleInstance>();
  private readonly maxPersistedModules: number;
  private readonly maxPinnedModules: number;
  private readonly onModuleCreated?: (instance: HypenModuleInstance) => void;
  /**
   * Serialized chain of in-flight route transitions. Because mount /
   * unmount are now async (they await `onActivated` / `onDeactivated`),
   * back-to-back navigations must not interleave. Each `handleRouteChange`
   * appends to this chain so transitions run strictly in order.
   */
  private navPromise: Promise<void> = Promise.resolve();

  constructor(
    router: HypenRouter,
    engine: IEngine,
    registry: HypenApp,
    globalContext: HypenGlobalContext,
    options: ManagedRouterOptions = {}
  ) {
    this.router = router;
    this.engine = engine;
    this.registry = registry;
    this.globalContext = globalContext;
    const cap = options.maxPersistedModules ?? DEFAULT_MAX_PERSISTED_MODULES;
    // Guard against obviously-invalid caps — a zero or negative limit would
    // mean "never persist", which the call site should express via
    // `persist: false` on definitions instead.
    this.maxPersistedModules = cap > 0 ? cap : DEFAULT_MAX_PERSISTED_MODULES;
    const pinCap = options.maxPinnedModules ?? MAX_BACKGROUND_PINNED_MODULES;
    this.maxPinnedModules = pinCap >= 0 ? pinCap : MAX_BACKGROUND_PINNED_MODULES;
    this.onModuleCreated = options.onModuleCreated;
  }

  /**
   * Add a route definition.
   */
  addRoute(route: RouteDefinition): this {
    this.routes.push(route);
    return this;
  }

  /**
   * Start listening for route changes and mount the initial route.
   *
   * Also installs the `@router.*` engine action handlers so DSL authors can
   * write `.onClick(@router.push, to: "/x")` / `@router.back` /
   * `@router.replace` / `@router.forward` and have them dispatched against
   * this session's `HypenRouter` without any per-example wiring. The
   * reserved namespace is set up by `hypen-engine` in `ir/expand.rs`.
   */
  start(): void {
    this.unsubscribe = this.router.onNavigate((routeState: RouteState) => {
      this.handleRouteChange(routeState);
    });
    this.installRouterActions();
  }

  /**
   * Register handlers for the reserved `router.*` action namespace.
   *
   * All navigations go through `queueMicrotask` so the router state mutation
   * lands after the engine finishes dispatching the action — synchronous
   * writes would re-enter the engine's WASM state proxy, which the Rust side
   * rejects ("recursive use of an object").
   */
  private installRouterActions(): void {
    const router = this.router;
    const defer = (fn: () => void) => queueMicrotask(fn);
    const readTo = (action: { payload?: unknown } | null | undefined): string | null => {
      const payload = action?.payload as Record<string, unknown> | null | undefined;
      const to = payload?.to;
      return typeof to === "string" && to.length > 0 ? to : null;
    };

    this.engine.onAction("router.push", (action) => {
      const to = readTo(action);
      if (to) defer(() => router.push(to));
    });
    this.engine.onAction("router.replace", (action) => {
      const to = readTo(action);
      if (to) defer(() => router.replace(to));
    });
    this.engine.onAction("router.back", () => {
      defer(() => router.back());
    });
    this.engine.onAction("router.forward", () => {
      defer(() => router.forward());
    });
  }

  /**
   * Stop listening and unmount the active module.
   * Also destroys all persisted modules.
   *
   * Waits for any in-flight navigation to settle before tearing down so
   * lifecycle hooks always complete in order.
   */
  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Wait for any in-flight navigation before tearing down.
    const cleanup = this.navPromise
      .catch(() => {
        /* previous navigation errors already reported */
      })
      .then(async () => {
        await this.unmountActive();

        // Destroy all persisted modules on full stop. Instances in this
        // map are inactive (they were deactivated when persisted), so
        // `destroy()` just fires `onDestroyed`.
        for (const [moduleId, instance] of this.persistedModules) {
          log.debug(`Destroying persisted module on stop: ${moduleId}`);
          try {
            await instance.destroy();
          } catch (e) {
            log.error(`Error destroying persisted module ${moduleId}:`, e);
          }
          this.createdInstances.delete(instance);
          this.globalContext.unregisterModule(moduleId);
          this.engine.unregisterModule?.(moduleId);
        }
        this.persistedModules.clear();
      });

    this.navPromise = cleanup;
    await cleanup;

    // Clean up router event listeners
    this.router.dispose();
  }

  /**
   * Returns a promise that resolves once all currently-queued route
   * transitions have finished. Useful in tests to await lifecycle
   * ordering without reaching into internals.
   */
  async waitForNavigation(): Promise<void> {
    try {
      await this.navPromise;
    } catch {
      /* navigation errors are logged; callers don't need to rethrow */
    }
  }

  /**
   * Get the currently active module instance.
   */
  getActiveModule(): HypenModuleInstance | null {
    return this.activeModule;
  }

  /**
   * Every live (not destroyed) module instance this router owns: the active
   * one, the persisted cache, and any instance mid-transition. Used to bind
   * connection-scoped facilities (e.g. a late-negotiated device broker,
   * RFC 001 §2.2) to modules that were mounted before they existed.
   */
  liveInstances(): HypenModuleInstance[] {
    const out: HypenModuleInstance[] = [];
    for (const instance of this.createdInstances) {
      if (instance.destroyed) this.createdInstances.delete(instance);
      else out.push(instance);
    }
    return out;
  }

  /**
   * Get the currently active route.
   */
  getActiveRoute(): RouteDefinition | null {
    return this.activeRoute;
  }

  private handleRouteChange(routeState: RouteState): void {
    // Chain onto the in-flight navigation promise so transitions run
    // strictly in order. Async activate/deactivate hooks otherwise make
    // it possible for a late `A → B` to finish before an earlier `B → A`.
    this.navPromise = this.navPromise
      .catch((e) => {
        log.error("Previous navigation failed:", e);
      })
      .then(() => this.processRouteChange(routeState));
  }

  private async processRouteChange(routeState: RouteState): Promise<void> {
    const path = routeState.currentPath;
    const matched = this.matchRoute(path);

    if (!matched) {
      log.debug(`No route matched for path: ${path}`);
      await this.unmountActive();
      return;
    }

    // If same route, no need to remount. Still a no-op for same-path
    // navigations (e.g. reselecting the active tab).
    if (this.activeRoute && this.activeRoute.path === matched.path) {
      return;
    }

    // Unmount old, mount new.
    await this.unmountActive();
    await this.mount(matched);
  }

  private matchRoute(path: string): RouteDefinition | null {
    for (const route of this.routes) {
      if (this.router.matchPath(route.path, path) !== null) {
        return route;
      }
    }
    return null;
  }

  private async mount(route: RouteDefinition): Promise<void> {
    // Look up module definition: inline first, then registry
    const definition = route.module || this.registry.get(route.component);
    if (!definition) {
      log.debug(`No module definition found for component: ${route.component}`);
      this.activeRoute = route;
      return;
    }

    // Ensure the definition has a name for state namespacing
    const namedDef = {
      ...definition,
      name: definition.name || route.component.toLowerCase(),
    };

    const moduleId = namedDef.name!.toLowerCase();

    // Check for a persisted instance first. If we hit the cache, we reuse
    // its state verbatim — `onCreated` has already fired (once) and
    // activate() below will fire `onActivated` without re-running the
    // one-time setup.
    const persisted = this.persistedModules.get(moduleId);
    if (persisted) {
      log.debug(`Restoring persisted module: ${moduleId} for route: ${route.path}`);
      this.activeModule = persisted;
      this.activeRoute = route;
      // Remove from the cache while it's active so that a concurrent
      // navigation can't double-mount the same instance.
      this.persistedModules.delete(moduleId);
      await persisted.activate();
      return;
    }

    log.debug(`Mounting module: ${namedDef.name} for route: ${route.path}`);

    const instance = new HypenModuleInstance(
      this.engine,
      namedDef as HypenModuleDefinition<object>,
      this.router,
      this.globalContext
    );

    // Prune anything destroyed out-of-band (e.g. by its owner) first.
    for (const known of this.createdInstances) {
      if (known.destroyed) this.createdInstances.delete(known);
    }
    this.createdInstances.add(instance);
    try {
      this.onModuleCreated?.(instance);
    } catch (e) {
      log.error(`onModuleCreated hook failed for ${moduleId}:`, e);
    }

    // Register in global context under the module name (lowercase)
    this.globalContext.registerModule(moduleId, instance);

    this.activeModule = instance;
    this.activeRoute = route;

    // Fire `onActivated` after `onCreated` resolves. `activate()` awaits
    // the instance's internal readiness promise, so this is safe even
    // though the constructor kicks off `onCreated` asynchronously.
    await instance.activate();
  }

  private async unmountActive(): Promise<void> {
    if (!this.activeModule || !this.activeRoute) {
      this.activeModule = null;
      this.activeRoute = null;
      return;
    }

    const active = this.activeModule;
    const route = this.activeRoute;
    const definition = route.module || this.registry.get(route.component);
    const moduleId = (definition?.name || route.component).toLowerCase();

    // Persistence default: any route backed by a module definition
    // persists unless the definition explicitly opts out.
    //
    //   definition present & persist !== false  →  cache the instance
    //   definition present & persist === false  →  destroy the instance
    //   definition missing                       →  nothing to persist
    //
    // This is the new default behavior — prior to this change, persist
    // was opt-in via `persist: true`. Modules that relied on a fresh
    // instance on every navigation should set `persist: false` or move
    // per-navigation work into the new `onActivated` hook.
    const persist = definition != null && definition.persist !== false;

    // Clear the active slot *before* firing lifecycle hooks so the
    // module cannot observe itself as "active" from inside onDeactivated.
    this.activeModule = null;
    this.activeRoute = null;

    // Always deactivate first — regardless of whether we persist or
    // destroy — so `onDeactivated → (onDestroyed)` ordering holds.
    try {
      await active.deactivate();
    } catch (e) {
      log.error(`Error deactivating module ${moduleId}:`, e);
    }

    if (persist) {
      log.debug(`Persisting module: ${moduleId}`);
      // If this id is already cached (e.g. after being destroyed and
      // re-activated without passing through mount(), though rare),
      // delete first so the re-insert places it at the MRU end.
      this.persistedModules.delete(moduleId);
      this.persistedModules.set(moduleId, active);
      await this.evictPersistedOverflow();
      // Keep registered in GlobalContext — and in the engine — so other
      // modules can still access its state while it's off-screen. This is
      // why `engine.unregisterModule` is a DESTROY-path call and not an
      // unmount-path one: dropping the engine registration here would take
      // the module's state and actions with it, breaking both the persist
      // cache and cross-module reads for a module that is merely
      // off-screen.
    } else {
      log.debug(`Unmounting module: ${moduleId}`);
      try {
        await active.destroy();
      } catch (e) {
        log.error(`Error destroying module ${moduleId}:`, e);
      }
      this.createdInstances.delete(active);
      this.globalContext.unregisterModule(moduleId);
      // Destroyed, not persisted — so its actions must stop being
      // externally dispatchable too.
      this.engine.unregisterModule?.(moduleId);
    }
  }

  /**
   * Trim `persistedModules` down to `maxPersistedModules` by destroying
   * the oldest entries (FIFO in Map insertion order, which tracks LRU
   * because `mount()` removes on restore and `unmountActive()` re-inserts
   * at the MRU end on every persist).
   *
   * Modules with live `background` device work are pinned (RFC 001 §2.7)
   * and skipped, up to `maxPinnedModules`; past that hard cap the oldest
   * pinned entry is evicted too. When every candidate is pinned and within
   * the cap, the loop logs and stops — each iteration either removes one
   * entry or exits, so it can never spin.
   *
   * Errors during eviction are logged — one misbehaving `onDestroyed` hook
   * must not block the router from shrinking the cache on the next
   * navigation.
   */
  private async evictPersistedOverflow(): Promise<void> {
    while (this.persistedModules.size > this.maxPersistedModules) {
      let victimId: string | null = null;
      let oldestPinned: string | null = null;
      let pinned = 0;
      for (const [id, instance] of this.persistedModules) {
        if (instance.hasLiveBackgroundDeviceWork) {
          pinned += 1;
          oldestPinned ??= id;
        } else if (victimId === null) {
          victimId = id;
        }
      }
      if (victimId === null) {
        if (pinned > this.maxPinnedModules && oldestPinned !== null) {
          log.warn(
            `Pinned module cap (${this.maxPinnedModules}) exceeded; evicting ${oldestPinned} and its background device work`
          );
          victimId = oldestPinned;
        } else {
          log.warn(
            `Persisted-module cache over cap (${this.persistedModules.size}/${this.maxPersistedModules}) but every candidate is pinned by background device work; stopping eviction`
          );
          break;
        }
      }
      const evicted = this.persistedModules.get(victimId)!;
      this.persistedModules.delete(victimId);
      log.debug(`Evicting persisted module (LRU): ${victimId}`);
      try {
        await evicted.destroy();
      } catch (e) {
        log.error(`Error destroying evicted module ${victimId}:`, e);
      }
      this.createdInstances.delete(evicted);
      this.globalContext.unregisterModule(victimId);
      this.engine.unregisterModule?.(victimId);
    }
  }
}
