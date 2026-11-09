/**
 * Browser URL <-> server-side route sync for remote web clients.
 *
 * Routing in a remote app is server state: a `Router { Route(path: ...) }`
 * renders whatever the root module's `state.location` holds (the `hypen init`
 * convention, and the engine's default Router binding). This keeps the
 * address bar in step with it:
 *
 *   - the app navigates (state.location changes)  -> history.pushState
 *   - back / forward (popstate)                    -> `router.replace` to
 *                                                     the URL's path
 *   - the page loads on a deep link (`/counter`)   -> `router.replace`
 *     before the first paint is shown, so a reload stays on the route.
 *
 * `router.replace` is the action every server's auto-wired router installs
 * for an app with a Router block; it moves the router, which writes
 * `state.location`. Apps whose state has no string `location` are left
 * alone (no state subscription, no history entries).
 *
 * Shared by the default web clients of the TypeScript `RemoteServer`, the Go
 * `RemoteServer` (same bundle) and the Cloudflare generic client.
 */

/** The slice of `RemoteEngine` the sync needs. */
export interface UrlSyncEngine {
  onInitialTree(callback: () => void): unknown;
  onStateUpdate(callback: (state: unknown) => void): unknown;
  subscribeState(): void;
  dispatchAction(name: string, payload?: unknown): void;
}

export interface UrlSyncOptions {
  /**
   * Element hidden while a deep link is being navigated to, so the default
   * route never flashes. Optional.
   */
  container?: HTMLElement | null;
  /**
   * Path prefix the app is mounted under (`"/canvas"`): app location `/x`
   * shows as `/canvas/x`. Default: none (the app owns the whole origin).
   */
  base?: string;
  /** State key holding the route (default `"location"`). */
  locationKey?: string;
  /** Action dispatched to move the router (default `"router.replace"`). */
  replaceAction?: string;
  /** Give up waiting for a URL-driven navigation after this long (ms). */
  timeoutMs?: number;
}

/** Normalise a mount prefix: "" for root, else "/x" without trailing slash. */
export function normalizeBase(base: string | undefined): string {
  if (!base) return "";
  let b = base.trim();
  if (!b.startsWith("/")) b = `/${b}`;
  b = b.replace(/\/+$/, "");
  return b;
}

/** App location -> URL path under `base`. */
export function locationToPath(loc: string, base: string): string {
  if (!base) return loc;
  return loc === "/" ? base : `${base}${loc}`;
}

/** URL path -> app location, or null when the path is outside `base`. */
export function pathToLocation(pathname: string, base: string): string | null {
  if (!base) return pathname || "/";
  if (pathname === base || pathname === `${base}/`) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return null;
}

/**
 * Keep `window.location` in step with the server's `state.location`.
 * Returns a disposer that removes the `popstate` listener.
 */
export function syncUrlWithRouter(
  engine: UrlSyncEngine,
  options: UrlSyncOptions = {},
): { dispose(): void } {
  const base = normalizeBase(options.base);
  const key = options.locationKey ?? "location";
  const replaceAction = options.replaceAction ?? "router.replace";
  const timeoutMs = options.timeoutMs ?? 1500;
  const container = options.container ?? null;

  /** First state of the current session not seen yet. */
  let awaitingInitial = true;
  /** Whether this session's state has been subscribed to. */
  let subscribed = false;
  /** Last `state.location` the server reported, or null when unknown. */
  let serverLocation: string | null = null;
  /** Location a URL-driven navigation is waiting for the server to reach. */
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const readLocation = (state: unknown): string | null => {
    if (!state || typeof state !== "object") return null;
    const value = (state as Record<string, unknown>)[key];
    return typeof value === "string" && value.startsWith("/") ? value : null;
  };

  const settle = (): void => {
    pending = null;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (container) container.style.visibility = "";
  };

  /** Ask the server to show `loc`; hold history pushes until it does. */
  const navigateTo = (loc: string, hideUntilThere: boolean): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pending = loc;
    if (hideUntilThere && container) container.style.visibility = "hidden";
    pendingTimer = setTimeout(settle, timeoutMs);
    engine.dispatchAction(replaceAction, { to: loc });
  };

  const onPopState = (): void => {
    if (serverLocation === null) return; // app has no `state.location`
    const loc = pathToLocation(location.pathname, base);
    if (loc === null) return;
    if (loc === serverLocation && pending === null) return;
    navigateTo(loc, false);
  };
  window.addEventListener("popstate", onPopState);

  // Every (re)connect streams a full initial tree followed by its state —
  // a new session starts from scratch (and must re-subscribe).
  engine.onInitialTree(() => {
    awaitingInitial = true;
    subscribed = false;
    serverLocation = null;
    settle();
  });

  engine.onStateUpdate((state) => {
    const loc = readLocation(state);
    if (awaitingInitial) {
      awaitingInitial = false;
      if (loc === null) return;
      // Navigation is server state; ask for every later change.
      if (!subscribed) {
        subscribed = true;
        engine.subscribeState();
      }
      serverLocation = loc;
      const wanted = pathToLocation(location.pathname, base);
      if (wanted !== null && wanted !== loc) navigateTo(wanted, true);
      return;
    }
    if (loc === null) return;
    serverLocation = loc;
    if (pending !== null) {
      // Intermediate states while the server catches up with the URL must
      // not push history entries of their own.
      if (loc === pending) settle();
      return;
    }
    const path = locationToPath(loc, base);
    if (path !== location.pathname) {
      history.pushState(null, "", path);
    }
  });

  return {
    dispose() {
      window.removeEventListener("popstate", onPopState);
      settle();
    },
  };
}
