/**
 * Hypen Radio on Cloudflare — live internet radio from the Radio Browser
 * directory, played by the cross-platform Video component as audio-only.
 *
 * - Audio never passes through this worker: clients connect straight to each
 *   station's https stream. The worker serves the UI over the Hypen socket,
 *   station artwork (`/art/<uuid>`), and reads ICY titles server-side.
 * - One Durable Object per visitor (`hypen_radio` cookie, see visitor.ts) —
 *   favourites and recently played persist in its storage.
 * - `request.cf.country` picks the "Popular in …" section; it's stamped into
 *   a header for the worker → DO hop and scoped per DO entry point.
 */

import { defineHypenWorker } from "@hypen-space/cf";
import { app } from "@hypen-space/core";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";

import appModule from "./components/App";
import discover from "./components/Discover";
import search from "./components/Search";
import categories from "./components/Categories";
import stationList from "./components/StationList";
import stationDetail from "./components/StationDetail";
import { resources } from "./icons";
import { serveArt } from "./art";
import {
  COUNTRY_HEADER,
  countryScope,
  edgeCountry,
  FALLBACK_COUNTRY,
  visitorCookie,
  visitorFrom,
} from "./visitor";

// Screen modules self-register on `app` when imported.
void discover;
void search;
void categories;
void stationList;
void stationDetail;

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app,
  componentTemplates: {},
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "RadioDO",
  binding: "RADIO_DO",
  getRoutingKey: (request) => {
    const visitor = visitorFrom(request);
    if (visitor) return `visitor:${visitor}`;
    // No cookie yet (first socket of an embed, or a native shell): the
    // fetch handler below mints one into the request before routing, so this
    // is only reached by clients that refuse cookies.
    return new URL(request.url).searchParams.get("sessionId") ?? crypto.randomUUID();
  },
  clients: {
    "/": { js: genericClientJs as string, renderer: "dom" },
    "/canvas": { js: genericClientJs as string, renderer: "canvas" },
  },
  title: "Radio — Hypen",
});

type BaseDOCtor = new (...args: never[]) => {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(...args: never[]): Promise<unknown>;
  webSocketClose(...args: never[]): Promise<unknown>;
  webSocketError(...args: never[]): Promise<unknown>;
};
const BaseDO = worker.RadioDO as unknown as BaseDOCtor;

const COUNTRY_KEY = "radio:country";

/** Same DO, with every entry point running inside this DO's country scope. */
export class RadioDO extends BaseDO {
  private country: string | null = null;

  private get storage(): { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } {
    return (this as unknown as { ctx: { storage: never } }).ctx.storage;
  }

  private async resolveCountry(): Promise<string> {
    if (!this.country) {
      // After hibernation the instance is fresh; the last socket's country
      // is in storage.
      const stored = await this.storage.get(COUNTRY_KEY);
      this.country = typeof stored === "string" ? stored : FALLBACK_COUNTRY;
    }
    return this.country;
  }

  override async fetch(request: Request): Promise<Response> {
    const header = request.headers.get(COUNTRY_HEADER);
    if (header && /^[A-Z]{2}$/.test(header)) {
      this.country = header;
      await this.storage.put(COUNTRY_KEY, header);
    }
    const country = await this.resolveCountry();
    return countryScope.run(country, () => super.fetch(request));
  }

  override async webSocketMessage(...args: never[]): Promise<unknown> {
    const country = await this.resolveCountry();
    return countryScope.run(country, () => super.webSocketMessage(...args));
  }

  override async webSocketClose(...args: never[]): Promise<unknown> {
    const country = await this.resolveCountry();
    return countryScope.run(country, () => super.webSocketClose(...args));
  }

  override async webSocketError(...args: never[]): Promise<unknown> {
    const country = await this.resolveCountry();
    return countryScope.run(country, () => super.webSocketError(...args));
  }
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  // A 101 upgrade carries its socket on `webSocket`, and must be rebuilt
  // with a null body around that same socket.
  const ws = (response as Response & { webSocket?: unknown }).webSocket;
  if (ws) {
    return new Response(null, { status: 101, headers, webSocket: ws } as ResponseInit);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/art/")) return serveArt(request);

    // Stamp the edge country for the DO hop (request.cf doesn't survive it).
    const headers = new Headers(request.headers);
    headers.set(COUNTRY_HEADER, edgeCountry(request) ?? "");
    if (!headers.get(COUNTRY_HEADER)) headers.delete(COUNTRY_HEADER);

    // First contact: mint the visitor id and route THIS request with it too,
    // so the socket opened before the cookie existed lands in the same DO
    // that later connections will use.
    let minted: string | null = null;
    if (!visitorFrom(request)) {
      minted = crypto.randomUUID();
      const prior = headers.get("Cookie");
      headers.set("Cookie", `${prior ? `${prior}; ` : ""}hypen_radio=${minted}`);
    }
    const forwarded = new Request(request, { headers });

    const response = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      forwarded,
      env,
      ctx,
    );
    if (!minted) return response;
    const isPage = (response.headers.get("content-type") ?? "").startsWith("text/html");
    if (response.status === 101 || isPage) {
      return withCookie(response, visitorCookie(minted, url.protocol === "https:"));
    }
    return response;
  },
};
