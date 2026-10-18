/**
 * Page half of the `hypen build` runtime.
 *
 * `hypen dev` runs the app through a `RemoteServer`: a `RemoteSession` owns
 * the engine and module instances (primary module, nested route modules,
 * the auto-wired router, scoped `@actions`) and streams patches to the
 * built-in web client. A production build has no server, so the build runs
 * that same `RemoteSession` in a Web Worker (build-worker.ts) and connects
 * the same client stack as the dev web client (`RemoteEngine` +
 * `DOMRenderer` + URL sync) to it over `postMessage`. Routes, nested-module
 * state, scoped actions and navigation behave exactly as under `hypen dev`.
 *
 * `hypen build` copies this file into the build's temp directory so its
 * `@hypen-space/*` imports resolve from the project's node_modules.
 */

import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web";
import type { FromWorker, ToWorker } from "./build-worker.ts";

export interface StartOptions {
  /** URL of the worker bundle (build-worker.ts entry). */
  workerUrl: string;
  /** Mount point. Default: "#app". */
  container?: string;
}

/**
 * A WebSocket look-alike whose other end is a `RemoteSession` in the
 * worker. Messages keep their order, like a socket.
 */
class WorkerSocket extends EventTarget {
  private static nextId = 1;
  readonly id = WorkerSocket.nextId++;
  readyState: number = 0; // CONNECTING
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  readonly protocol = "";
  readonly extensions = "";
  onopen: ((ev: Event) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly worker: Worker,
    sockets: Map<number, WorkerSocket>
  ) {
    super();
    sockets.set(this.id, this);
    this.post({ t: "open", id: this.id });
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1; // OPEN
      const ev = new Event("open");
      this.onopen?.(ev);
      this.dispatchEvent(ev);
    }, 0);
  }

  private post(message: ToWorker): void {
    this.worker.postMessage(message);
  }

  send(data: string): void {
    if (this.readyState === 1) this.post({ t: "msg", id: this.id, data });
  }

  /** Worker -> page. */
  deliver(data: string): void {
    if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** The worker closed the session. */
  closed(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.dispatchEvent(new CloseEvent("close"));
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.post({ t: "close", id: this.id });
    this.closed();
  }
}

function showError(container: HTMLElement, message: string): void {
  console.error(`[hypen] ${message}`);
  const box = document.createElement("pre");
  box.setAttribute(
    "style",
    "margin:16px;padding:12px;color:#b91c1c;background:#fef2f2;white-space:pre-wrap;font:13px ui-monospace,monospace;"
  );
  box.textContent = `Hypen app failed to start:\n${message}`;
  container.replaceChildren(box);
}

/** Mount the app; resolves once connected to the worker's session. */
export async function startHypenApp(options: StartOptions): Promise<RemoteEngine> {
  const container = document.querySelector<HTMLElement>(options.container ?? "#app");
  if (!container) throw new Error(`Hypen: container ${options.container ?? "#app"} not found`);

  const worker = new Worker(options.workerUrl, { type: "module", name: "hypen" });
  const sockets = new Map<number, WorkerSocket>();
  worker.addEventListener("message", (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    if (msg.t === "msg") sockets.get(msg.id)?.deliver(msg.data);
    else if (msg.t === "close") sockets.get(msg.id)?.closed();
    else if (msg.t === "error") showError(container, msg.message);
  });
  worker.addEventListener("error", (ev) =>
    showError(container, ev.message || "the app worker failed to load")
  );

  const engine = new RemoteEngine("hypen://worker", {
    session: { props: { platform: "web" } },
    // The session lives in this page's worker: nothing to reconnect to.
    autoReconnect: false,
    webSocketFactory: (url) => new WorkerSocket(url, worker, sockets) as unknown as WebSocket,
  });

  const urlSync = createUrlSync(engine, container);
  engine.onStateUpdate((state) => urlSync.onState(state));

  let renderer: DOMRenderer | null = null;
  engine.onSessionEstablished(() => {
    container.innerHTML = "";
    renderer = new DOMRenderer(container, {
      dispatchAction: (name: string, payload?: unknown) => engine.dispatchAction(name, payload),
    });
    urlSync.sessionStarted();
  });
  engine.onPatches((patches) => renderer?.applyPatches(patches));

  const result = await engine.connect();
  if (!result.ok) throw result.error;
  return engine;
}

// ---------------------------------------------------------------------------
// URL <-> route sync (same behavior as the `hypen dev` web client)
//
// The router writes the root module's `state.location`:
//   - the app navigates (state.location changes) -> history.pushState
//   - back / forward (popstate)                   -> `router.replace`
//   - the page loads on a deep link (`/counter`)  -> `router.replace` before
//                                                    the first paint shows
// Apps whose state has no string `location` are left alone.
// ---------------------------------------------------------------------------

const NAVIGATION_TIMEOUT_MS = 1500;

function readLocation(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>).location;
  return typeof value === "string" && value.startsWith("/") ? value : null;
}

function createUrlSync(engine: RemoteEngine, container: HTMLElement) {
  let awaitingInitial = true;
  let serverLocation: string | null = null;
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function settle(): void {
    pending = null;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    container.style.visibility = "";
  }

  function navigateTo(path: string, hideUntilThere: boolean): void {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pending = path;
    if (hideUntilThere) container.style.visibility = "hidden";
    pendingTimer = setTimeout(settle, NAVIGATION_TIMEOUT_MS);
    engine.dispatchAction("router.replace", { to: path });
  }

  window.addEventListener("popstate", () => {
    if (serverLocation === null) return;
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
        engine.subscribeState();
        serverLocation = loc;
        if (loc !== location.pathname) navigateTo(location.pathname, true);
        return;
      }
      if (loc === null) return;
      serverLocation = loc;
      if (pending !== null) {
        if (loc === pending) settle();
        return;
      }
      if (loc !== location.pathname) history.pushState(null, "", loc);
    },
  };
}
