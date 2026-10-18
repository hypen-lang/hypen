/**
 * Default browser client for `RemoteServer`.
 *
 * This file is NOT imported by the server at runtime — it is the entrypoint
 * `web-client.ts` hands to `Bun.build` (target: browser) to produce the
 * bundle served at `/__hypen__/client.js`. It connects back to the server
 * that served it over WebSocket, applies streamed patches with the DOM
 * renderer, and forwards user actions to the server.
 *
 * Patches are computed server-side, so no WASM ships to the browser — the
 * bundle is just the remote protocol client plus the patch-consuming DOM
 * renderer.
 */

import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web";

const container = document.getElementById("app");
if (!container) {
  throw new Error("Hypen web client: #app container not found");
}

const proto = location.protocol === "https:" ? "wss" : "ws";
const engine = new RemoteEngine(`${proto}://${location.host}`, {
  session: { props: { platform: "web" } },
  // Dev hot reload works by the server dropping the socket; reconnect
  // quickly so an edit shows up in well under a second.
  reconnectInterval: 500,
  // No `navigation` option: the URL sync below replaces it (it pushed
  // entries without changing the URL and could only go back).
});

function makeRenderer(): DOMRenderer {
  return new DOMRenderer(container!, {
    dispatchAction: (name: string, payload?: unknown) => {
      engine.dispatchAction(name, payload);
    },
  });
}

let renderer = makeRenderer();

// Every (re)established session streams a complete initial tree, so reset
// the renderer first — otherwise a hot-reload reconnect appends a second
// copy of the app under the old one.
engine.onSessionEstablished(() => {
  container.innerHTML = "";
  renderer = makeRenderer();
  urlSync.sessionStarted();
});

engine.onPatches((patches) => renderer.applyPatches(patches));

// ---------------------------------------------------------------------------
// URL <-> route sync
//
// Routing is server-side: a `Router { Route(path: ...) }` renders whatever
// the root module's `state.location` holds (the `hypen init` convention,
// and the engine's default Router binding). This keeps the address bar in
// step with it:
//
//   - the app navigates (state.location changes)  -> history.pushState
//   - back / forward (popstate)                    -> `router.replace` to
//                                                     the URL's path
//   - the page loads on a deep link (`/counter`)   -> `router.replace`
//     before the first paint is shown, so a reload stays on the route.
//
// `router.replace` is the action the server's auto-wired router installs
// for every app with a Router block; it moves the router, which writes
// `state.location`. Apps whose state has no string `location` are left
// alone.
// ---------------------------------------------------------------------------

const LOCATION_KEY = "location";
/** Give up waiting for a URL-driven navigation after this long. */
const NAVIGATION_TIMEOUT_MS = 1500;

function readLocation(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[LOCATION_KEY];
  return typeof value === "string" && value.startsWith("/") ? value : null;
}

const urlSync = (() => {
  /** First state of the current session not seen yet. */
  let awaitingInitial = true;
  /** Last `state.location` the server reported, or null when unknown. */
  let serverLocation: string | null = null;
  /** Path a URL-driven navigation is waiting for the server to reach. */
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function settle(): void {
    pending = null;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    container!.style.visibility = "";
  }

  /** Ask the server to show `path`; hold history pushes until it does. */
  function navigateTo(path: string, hideUntilThere: boolean): void {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pending = path;
    if (hideUntilThere) container!.style.visibility = "hidden";
    pendingTimer = setTimeout(settle, NAVIGATION_TIMEOUT_MS);
    engine.dispatchAction("router.replace", { to: path });
  }

  window.addEventListener("popstate", () => {
    if (serverLocation === null) return; // app has no `state.location`
    const path = location.pathname;
    if (path === serverLocation && pending === null) return;
    navigateTo(path, false);
  });

  return {
    sessionStarted(): void {
      awaitingInitial = true;
      serverLocation = null;
      settle();
    },
    onState(state: unknown): void {
      const loc = readLocation(state);
      if (awaitingInitial) {
        awaitingInitial = false;
        if (loc === null) return;
        // Navigation is server state; ask for every later change.
        engine.subscribeState();
        serverLocation = loc;
        if (loc !== location.pathname) navigateTo(location.pathname, true);
        return;
      }
      if (loc === null) return;
      serverLocation = loc;
      if (pending !== null) {
        // Intermediate states while the server catches up with the URL
        // must not push history entries of their own.
        if (loc === pending) settle();
        return;
      }
      if (loc !== location.pathname) {
        history.pushState(null, "", loc);
      }
    },
  };
})();

engine.onStateUpdate((state) => urlSync.onState(state));

function showBanner(text: string): void {
  let banner = document.getElementById("hypen-status");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "hypen-status";
    banner.setAttribute(
      "style",
      "position:fixed;bottom:12px;right:12px;padding:6px 12px;" +
        "background:#1f2937;color:#f9fafb;border-radius:8px;" +
        "font:12px system-ui,sans-serif;opacity:0.9;z-index:9999;",
    );
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.display = "block";
}

function hideBanner(): void {
  const banner = document.getElementById("hypen-status");
  if (banner) banner.style.display = "none";
}

engine.onConnect(() => hideBanner());
engine.onDisconnect(() => showBanner("Disconnected — reconnecting…"));

// `window.__hypen`: the hook an app uses to hand its session id to an
// agent, so the agent can attach to THIS session (`RemoteServer.attach` /
// `POST /__hypen__/agent/sessions` with `{ sessionId }`) and the user sees
// the result of what it does.
//
// The id is this browser's session resume token: whoever presents it over
// the WebSocket resumes this session's saved state. Forward it only to a
// backend you trust — the same one the app authenticates against — never
// to a third party, and never embed it in a URL. The server's `authorize`
// callback is where that trust is checked; this global only makes the id
// reachable from page script.
//
// Frozen so page code (or an extension) cannot swap the accessor for one
// that returns somebody else's id.
declare global {
  interface Window {
    __hypen?: Readonly<{
      /** The current session id, or `null` before the first `sessionAck`. */
      getSessionId(): string | null;
      /** Fires on every (re)established session with its id. */
      onSessionEstablished(callback: (sessionId: string) => void): void;
    }>;
  }
}

window.__hypen = Object.freeze({
  getSessionId: () => engine.getSessionId(),
  onSessionEstablished: (callback: (sessionId: string) => void) => {
    engine.onSessionEstablished((info) => callback(info.sessionId));
  },
});

const result = await engine.connect();
if (!result.ok) {
  showBanner(`Could not connect to ${proto}://${location.host} — is the server running?`);
}
