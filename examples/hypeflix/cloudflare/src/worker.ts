import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";

import appModule from "./components/App";
import { posterSource } from "./queries";
import { resources } from "./icons";
import browseModule from "./components/Browse";
import movieDetailModule from "./components/MovieDetail";
import watchModule from "./components/Watch";

// Screen modules register on the shared `app` registry as an import
// side effect; `void` keeps the imports from being flagged as unused.
void browseModule;
void movieDetailModule;
void watchModule;

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app,
  componentTemplates: {},
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "HypeflixDO",
  binding: "HYPEFLIX_DO",
  clients: {
    "/": { js: genericClientJs as string, renderer: "dom" },
    "/canvas": { js: genericClientJs as string, renderer: "canvas" },
  },
  title: "Hypeflix — Hypen",
});

export const HypeflixDO = worker.HypeflixDO;

/**
 * Cached poster proxy: `/poster/:id` → archive.org's image service.
 *
 * archive.org's poster endpoint is slow/flaky enough that clients fetching
 * a grid of posters directly routinely hit timeouts. Routing them through
 * the worker gives every poster an edge-cache entry (and same-origin
 * requests), so only the first viewer of a title ever waits on
 * archive.org. Failures are cached briefly to avoid hammering upstream.
 */
const POSTER_PREFIX = "/poster/";
const POSTER_TTL_S = 86400; // a day — posters are immutable per id
const POSTER_FAIL_TTL_S = 60;
const POSTER_TIMEOUT_MS = 8000;

async function posterProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.slice(POSTER_PREFIX.length));
  if (!id || id.includes("/")) return new Response("bad poster id", { status: 400 });

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const source = posterSource(id);
  if (!source) return new Response("unknown poster id", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(source, {
      signal: AbortSignal.timeout(POSTER_TIMEOUT_MS),
      // Wikimedia requires a User-Agent; redirects (Special:FilePath) are
      // followed by default.
      headers: { "User-Agent": "HypenflixExample/1.0 (Hypen Video component demo)" },
    });
  } catch {
    return new Response("poster upstream timeout", {
      status: 504,
      headers: { "cache-control": `public, max-age=${POSTER_FAIL_TTL_S}` },
    });
  }
  if (!upstream.ok) {
    return new Response("poster upstream error", {
      status: 502,
      headers: { "cache-control": `public, max-age=${POSTER_FAIL_TTL_S}` },
    });
  }
  const body = await upstream.arrayBuffer();
  const response = new Response(body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": `public, max-age=${POSTER_TTL_S}`,
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname.startsWith(POSTER_PREFIX)) {
      return posterProxy(request);
    }
    return (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      request,
      env,
      ctx,
    );
  },
};
