/**
 * Hypen Home on Cloudflare — a phone-style home screen for Hypen apps.
 *
 * All the interesting bits (the APPS list and the generated home-screen DSL)
 * live in launcher.ts. This entry wires in the WASM engine and shared browser
 * client explicitly so it matches the other deployed CF examples.
 *
 * The clock/weather widget needs the caller's geolocation, which only exists
 * as `request.cf` on the edge request. The worker fetch stamps it into a
 * header (headers always survive the worker → DO hop; `request.cf` does not
 * reliably), and the DO subclass — which shares an isolate with the module
 * handlers — parses it into the geo slot that launcher.ts reads.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../../../../hypen-web/packages/cf/dist/client/generic.js";
import launcher, { resources } from "./launcher";
import { GEO_HEADER, captureGeo, geoHeaderValue } from "./geo";

const worker = defineHypenWorker({
  module: launcher,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "HomeScreenDO",
  binding: "HOME_SCREEN_DO",
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Home",
});

const BaseDO = worker.HomeScreenDO as { new (...args: never[]): { fetch(request: Request): Promise<Response> } };

/** Same DO, but it parks the upgrade request's geo for the launcher module. */
export class HomeScreenDO extends BaseDO {
  override async fetch(request: Request): Promise<Response> {
    captureGeo(request);
    return super.fetch(request);
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> | Response {
    const geo = geoHeaderValue((request as Request & { cf?: unknown }).cf);
    if (geo) {
      const headers = new Headers(request.headers);
      headers.set(GEO_HEADER, geo);
      request = new Request(request, { headers });
    }
    return (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response> | Response)(
      request,
      env,
      ctx,
    );
  },
};
