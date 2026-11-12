/**
 * Hypen Weather on Cloudflare — Open-Meteo forecast, one Durable Object per
 * visitor.
 *
 * Routing: the first page load mints a `hypen_weather` visitor cookie
 * (HttpOnly, SameSite=Lax), and every socket carrying it lands in that
 * visitor's DO — so saved cities and the °C/°F choice survive reloads and
 * are shared by the visitor's tabs. A client without the cookie (the
 * home-screen launcher's `HypenApp` embed from another site, a native shell)
 * goes to one shared DO: everything still works, the saved-city list is just
 * shared by those clients.
 *
 * Geo: `request.cf` only exists on the edge request. The worker stamps it
 * into a header (headers survive the worker → DO hop), the DO subclass keeps
 * the latest upgrade's geo (in memory and in DO storage, for hibernation),
 * and runs each entry point inside `geoScope.run`, which is what
 * `connectionGeo()` in the module's `onCreated` reads (geo.ts).
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import weather from "./weather";
import { FALLBACK_GEO, GEO_HEADER, geoFromRequest, geoHeaderValue, geoScope, type ConnectionGeo } from "./geo";

const VISITOR_COOKIE = "hypen_weather";
const VISITOR_ID = /^[0-9a-f-]{36}$/;
const SHARED_KEY = "weather:shared";

function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_weather=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

const worker = defineHypenWorker({
  module: weather,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "WeatherDO",
  binding: "WEATHER_DO",
  getRoutingKey: (request) => {
    const visitor = visitorFrom(request);
    return visitor ? `visitor:${visitor}` : SHARED_KEY;
  },
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Weather",
});

const BaseDO = worker.WeatherDO as unknown as {
  new (...args: never[]): {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(...args: never[]): Promise<unknown>;
    webSocketClose(...args: never[]): Promise<unknown>;
    webSocketError(...args: never[]): Promise<unknown>;
  };
};

interface GeoStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

const GEO_KEY = "weather:geo";

/** The base DO, with every entry point running inside this DO's geo scope. */
export class WeatherDO extends BaseDO {
  private geo: ConnectionGeo | null = null;

  private get storage(): GeoStorage {
    return (this as unknown as { ctx: { storage: GeoStorage } }).ctx.storage;
  }

  private async currentGeo(): Promise<ConnectionGeo> {
    if (!this.geo) {
      // Woken from hibernation: the in-memory copy is gone.
      const stored = (await this.storage.get(GEO_KEY).catch(() => null)) as ConnectionGeo | null;
      this.geo = stored ?? FALLBACK_GEO;
    }
    return this.geo;
  }

  override async fetch(request: Request): Promise<Response> {
    const fromRequest = geoFromRequest(request);
    if (fromRequest) {
      this.geo = fromRequest;
      await this.storage.put(GEO_KEY, fromRequest).catch(() => undefined);
    }
    const geo = await this.currentGeo();
    return geoScope.run(geo, () => super.fetch(request));
  }

  override async webSocketMessage(...args: never[]): Promise<unknown> {
    const geo = await this.currentGeo();
    return geoScope.run(geo, () => super.webSocketMessage(...args));
  }

  override async webSocketClose(...args: never[]): Promise<unknown> {
    const geo = await this.currentGeo();
    return geoScope.run(geo, () => super.webSocketClose(...args));
  }

  override async webSocketError(...args: never[]): Promise<unknown> {
    const geo = await this.currentGeo();
    return geoScope.run(geo, () => super.webSocketError(...args));
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const visitor = visitorFrom(request);

    const geo = geoHeaderValue((request as Request & { cf?: unknown }).cf);
    if (geo) {
      const headers = new Headers(request.headers);
      headers.set(GEO_HEADER, geo);
      request = new Request(request, { headers });
    }
    const response = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response> | Response)(
      request,
      env,
      ctx,
    );

    // First page load: mint the visitor id the next socket is routed on.
    const isPage = request.method === "GET" && (response.headers.get("content-type") ?? "").startsWith("text/html");
    if (!visitor && isPage) {
      const secure = url.protocol === "https:" ? "; Secure" : "";
      const headers = new Headers(response.headers);
      headers.append(
        "Set-Cookie",
        `${VISITOR_COOKIE}=${crypto.randomUUID()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
      );
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};
