/**
 * Hypen Router - Declarative routing system
 * Integrated with Hypen's reactive state management
 */

import { createObservableState, getStateSnapshot } from "./state.js";
import { disposableListener, type Disposable } from "./disposable.js";
import { frameworkLoggers } from "./logger.js";
import { portable } from "./portable.js";

const log = frameworkLoggers.router;

export type RouteMatch = {
  params: Record<string, string>;
  query: Record<string, string>;
  path: string;
};

export type RouteState = {
  currentPath: string;
  params: Record<string, string>;
  query: Record<string, string>;
  previousPath: string | null;
};

export type RouteChangeCallback = (route: RouteState) => void;

/**
 * Hypen Router - Manages application routing with pattern matching
 */
export class HypenRouter {
  private state: RouteState;
  private subscribers = new Set<RouteChangeCallback>();
  private isInitialized = false;
  private isUpdating = false;
  private browserListeners: Disposable[] = [];

  constructor() {
    // Create observable state for reactivity
    this.state = createObservableState<RouteState>(
      {
        currentPath: "/",
        params: {},
        query: {},
        previousPath: null,
      },
      {
        onChange: () => {
          this.notifySubscribers();
        },
      }
    );

    // Initialize from browser if available
    if (typeof window !== "undefined") {
      this.initializeBrowserSync();
    }
  }

  /**
   * Initialize browser history sync
   */
  private initializeBrowserSync() {
    // Get initial path from hash or pathname
    const initialPath = this.getPathFromBrowser();
    this.state.currentPath = initialPath;
    this.state.params = {};
    this.state.query = this.parseQuery();

    // Listen for browser back/forward
    this.browserListeners.push(
      disposableListener(window, "popstate", () => {
        const newPath = this.getPathFromBrowser();
        this.updatePath(newPath, false); // Don't push to history again
      })
    );

    // Listen for hash changes
    this.browserListeners.push(
      disposableListener(window, "hashchange", () => {
        // Don't respond to hashchange events we triggered ourselves
        if (this.isUpdating) return;
        const newPath = this.getPathFromBrowser();
        this.updatePath(newPath, false);
      })
    );

    this.isInitialized = true;
    log.debug("Router initialized at:", initialPath);
  }

  /**
   * Get path from browser URL (supports both hash and pathname)
   */
  private getPathFromBrowser(): string {
    if (typeof window === "undefined") return "/";

    // Prefer hash-based routing for simplicity
    const hash = window.location.hash.slice(1);
    if (hash) return hash;

    // Fallback to pathname
    return window.location.pathname;
  }

  /**
   * Parse query string from URL
   */
  private parseQuery(): Record<string, string> {
    if (typeof window === "undefined") return {};

    const query: Record<string, string> = {};
    const searchParams = new URLSearchParams(window.location.search);

    searchParams.forEach((value, key) => {
      query[key] = value;
    });

    return query;
  }

  /**
   * Navigate to a new path
   */
  push(path: string) {
    log.debug("push:", path);
    this.updatePath(path, true);
  }

  /**
   * Replace current path without adding to history
   */
  replace(path: string) {
    log.debug("replace:", path);
    this.updatePath(path, true, true);
  }

  /**
   * Go back in history
   */
  back() {
    log.debug("back");
    if (typeof window !== "undefined") {
      window.history.back();
    }
  }

  /**
   * Go forward in history
   */
  forward() {
    log.debug("forward");
    if (typeof window !== "undefined") {
      window.history.forward();
    }
  }

  /**
   * Update the current path
   */
  private updatePath(
    path: string,
    updateBrowser: boolean,
    replace: boolean = false
  ) {
    // Prevent re-entrant updates
    if (this.isUpdating) return;

    this.isUpdating = true;
    try {
      const oldPath = this.state.currentPath;
      this.state.previousPath = oldPath;
      this.state.currentPath = path;
      this.state.query = this.parseQuery();

      // Notify subscribers synchronously before any browser events
      this.notifySubscribers();

      // Update browser URL if needed
      if (updateBrowser && typeof window !== "undefined") {
        const url = "#" + path;
        if (replace) {
          window.history.replaceState(null, "", url);
        } else {
          window.history.pushState(null, "", url);
        }

        // Manually trigger hashchange event.  Wrap in try-catch because
        // in test environments the global HashChangeEvent class may come
        // from a different realm than the window, causing dispatchEvent to
        // reject it with "parameter 1 is not of type 'Event'".
        try {
          const hashChangeEvent = new HashChangeEvent("hashchange", {
            oldURL: window.location.href.replace(window.location.hash, "#" + oldPath),
            newURL: window.location.href,
          });
          window.dispatchEvent(hashChangeEvent);
        } catch {
          // Ignore cross-realm Event dispatch errors
        }
      }
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Get current path
   */
  getCurrentPath(): string {
    return this.state.currentPath;
  }

  /**
   * Get current route params
   */
  getParams(): Record<string, string> {
    return { ...this.state.params };
  }

  /**
   * Get current query params
   */
  getQuery(): Record<string, string> {
    return { ...this.state.query };
  }

  /**
   * Get full route state snapshot
   */
  getState(): RouteState {
    return getStateSnapshot(this.state);
  }

  /**
   * Match a pattern against a path.
   *
   * Thin wrapper over [`portable.matchPath`] — the three-case matcher
   * (exact / `/prefix/*` wildcard / `:param`) lives in the Rust engine
   * at `hypen-engine-rs/src/portable/route.rs` and is reached through
   * the WASM installed by server / web-engine, with a TS fallback for
   * standalone core use.
   */
  matchPath(pattern: string, path: string): RouteMatch | null {
    if (!pattern || typeof pattern !== "string") return null;
    if (!path || typeof path !== "string") return null;

    // Strip any query portion before matching; the engine matcher
    // operates on the clean path and we track `query` ourselves.
    // `noUncheckedIndexedAccess` makes `[0]` `string | undefined`; fall
    // back to the full path when split yields an empty array (which
    // only happens for empty input — already ruled out above).
    const cleanPath = path.split("?")[0] ?? path;
    const result = portable.matchPath(pattern, cleanPath);
    if (!result) return null;

    const params: Record<string, string> = {};
    for (const [name, raw] of Object.entries(result.params)) {
      try {
        params[name] = decodeURIComponent(raw);
      } catch {
        params[name] = raw;
      }
    }

    return {
      params,
      query: this.state.query,
      path,
    };
  }

  /**
   * Subscribe to route changes
   */
  onNavigate(callback: RouteChangeCallback): () => void {
    this.subscribers.add(callback);

    // Call immediately with current state
    try {
      callback(this.getState());
    } catch (error) {
      log.error("Error in route subscriber:", error);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of route change
   */
  private notifySubscribers() {
    const routeState = this.getState();
    this.subscribers.forEach((callback) => {
      try {
        callback(routeState);
      } catch (error) {
        log.error("Error in route subscriber:", error);
      }
    });
  }

  /**
   * Check if a path matches the current route
   */
  isActive(pattern: string): boolean {
    return this.matchPath(pattern, this.state.currentPath) !== null;
  }

  /**
   * Get a URL with query params
   */
  buildUrl(path: string, query?: Record<string, string>): string {
    if (!query || Object.keys(query).length === 0) {
      return path;
    }

    const queryString = new URLSearchParams(query).toString();
    return `${path}?${queryString}`;
  }

  /**
   * Clean up browser event listeners and subscriptions
   */
  dispose(): void {
    for (const listener of this.browserListeners) {
      listener.dispose();
    }
    this.browserListeners = [];
    this.subscribers.clear();
    this.isInitialized = false;
    log.debug("Router disposed");
  }

  /**
   * Support `using` syntax for automatic cleanup
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
