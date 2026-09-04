/**
 * Hypen entry point.
 *
 * Mirrors the React `createRoot(...).render(<App />)` call: boot the runtime,
 * mount into `#app`, then flip `window.__appReady` after the first painted
 * frame so the driver measures the same milestone on both sides.
 *
 * The WASM engine is self-hosted from `/wasm/` (copied out of
 * `@hypen-space/web-engine/wasm-browser` by `scripts/prepare.ts`) rather than
 * pulled from the default unpkg CDN — a cross-origin CDN fetch would make the
 * startup number a measurement of the network, not the runtime.
 */

import { Hypen } from "@hypen-space/web-engine";
import benchModule from "./module";
import { template } from "./template";

const hypen = new Hypen({
  jsUrl: new URL("/wasm/hypen_engine.js", location.origin).href,
  wasmUrl: new URL("/wasm/hypen_engine_bg.wasm", location.origin).href,
});

await hypen.init();
hypen.registerComponent("App", benchModule, template);
await hypen.render("App", "#app");

document.querySelector("#app")?.firstElementChild?.setAttribute(
  "data-framework",
  "hypen",
);

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    (window as any).__appReady = true;
    (window as any).__startupMs = performance.now();
  }),
);
