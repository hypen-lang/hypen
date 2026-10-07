/**
 * Generic browser client shipped (prebuilt) inside @hypen-space/cf.
 *
 * `defineHypenWorker({ serveClient: true })` serves this from the worker so an
 * app gets a working browser UI with zero client files. It's app-agnostic: it
 * connects back to the same worker's `/ws` (deriving `wss://` from
 * `location`) and renders patches with either the DOM or Canvas renderer,
 * chosen by the `data-hypen-renderer` attribute the served HTML shell sets.
 *
 * Apps that need to customise (session keys, status UI, renderer options)
 * eject: build their own client and pass it via `defineHypenWorker({ clients })`.
 *
 * Device plane (RFC 001): the page attaches a browser DeviceHost
 * (`@hypen-space/device-web`) so module handlers can use
 * `context.device` — pick photos and files, capture, save downloads. Every
 * `HypenApp` embed gets its own host, whose consent UI names the embedded
 * app's origin. The server decides whether a plane is negotiated
 * (`defineHypenWorker({ device: false })` keeps it off).
 *
 * This file is bundled to `dist/client/generic.js` by the package's
 * `build:client` step and embedded via wrangler's Text rule. It is NOT part of
 * the package's TS source build (it uses DOM globals); it's compiled only by
 * the browser-target bundler.
 */

import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web/dom";
import { CanvasRenderer } from "@hypen-space/web/canvas";
import { WebDeviceHost } from "@hypen-space/device-web";

/** A DeviceHost naming the origin of the server at `url` in its prompts. */
function deviceHostFor(url: string): WebDeviceHost | undefined {
  try {
    return new WebDeviceHost({ origin: new URL(url).origin });
  } catch {
    return undefined;
  }
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const routeId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${proto}://${location.host}/ws?sessionId=${encodeURIComponent(`web-${routeId}`)}`;
}

const renderer = document.body.dataset.hypenRenderer === "canvas" ? "canvas" : "dom";
const mount = document.getElementById("app")!;

const url = wsUrl();
const device = deviceHostFor(url);
const engine = new RemoteEngine(url, {
  ...(device ? { device } : {}),
  autoReconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  session: { props: { platform: renderer === "canvas" ? "web_canvas" : "web" } },
  navigation: { backAction: "navigateBack", viewStateKey: "location" },
});

const view =
  renderer === "canvas"
    ? new CanvasRenderer(mount as HTMLCanvasElement, engine, {
        devicePixelRatio: window.devicePixelRatio,
        backgroundColor: "#ffffff",
      })
    : new DOMRenderer(mount as HTMLElement, engine, undefined, { hypenAppDevice: deviceHostFor });

let hasRenderedRoot = false;

engine.onPatches((patches) => {
  const createdIds = new Set(
    patches
      .filter((patch) => patch.type === "create")
      .map((patch) => patch.id),
  );
  const hasReplacementRoot = patches.some(
    (patch) =>
      patch.type === "insert" &&
      patch.parentId === "root" &&
      createdIds.has(patch.id),
  );

  if (hasReplacementRoot && hasRenderedRoot) {
    view.clear();
  }

  view.applyPatches(patches);
  hasRenderedRoot = hasRenderedRoot || hasReplacementRoot;
});

engine.connect();
