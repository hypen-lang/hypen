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
 * This file is bundled to `dist/client/generic.js` by the package's
 * `build:client` step and embedded via wrangler's Text rule. It is NOT part of
 * the package's TS source build (it uses DOM globals); it's compiled only by
 * the browser-target bundler.
 */

import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web/dom";
import { CanvasRenderer } from "@hypen-space/web/canvas";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

const renderer = document.body.dataset.hypenRenderer === "canvas" ? "canvas" : "dom";
const mount = document.getElementById("app")!;

const engine = new RemoteEngine(wsUrl(), {
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
    : new DOMRenderer(mount as HTMLElement, engine);

engine.onPatches((patches) => view.applyPatches(patches));

engine.connect();
