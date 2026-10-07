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
 *
 * Files: each visitor gets their own Durable Object, keyed by a random
 * `hypen_home` cookie (HttpOnly, SameSite=Lax — so a cross-site page cannot
 * open a socket into someone else's drive). The DO wraps every entry point
 * in `driveScope.run({ storage, bucket, prefix }, …)` so the Files handlers reach THIS
 * DO's SQLite, even across long `await`s on a device pick (see drive.ts).
 * `GET /drive/<id>` serves image thumbnails from the same DO.
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
import { driveScope, servePreview, type DriveBucket, type DriveScope, type DriveStorage } from "./drive";

const VISITOR_COOKIE = "hypen_home";
const VISITOR_ID = /^[0-9a-f-]{36}$/;

function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_home=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

const worker = defineHypenWorker({
  module: launcher,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "HomeScreenDO",
  binding: "HOME_SCREEN_DO",
  // One Durable Object per visitor (the Files app's drive lives in it). A
  // client with no cookie (a native shell) gets the default session routing.
  getRoutingKey: (request) => {
    const visitor = visitorFrom(request);
    if (visitor) return `visitor:${visitor}`;
    return new URL(request.url).searchParams.get("sessionId") ?? crypto.randomUUID();
  },
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Home",
});

const BaseDO = worker.HomeScreenDO as unknown as {
  new (...args: never[]): {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(...args: never[]): Promise<unknown>;
    webSocketClose(...args: never[]): Promise<unknown>;
    webSocketError(...args: never[]): Promise<unknown>;
  };
};

/**
 * Same DO, but it parks the upgrade request's geo for the launcher module,
 * runs every entry point inside this DO's drive scope, and serves previews.
 */
export class HomeScreenDO extends BaseDO {
  private get drive(): DriveScope {
    const self = this as unknown as {
      ctx: { storage: DriveStorage; id: { toString(): string } };
      env: { FILES: DriveBucket };
    };
    return { storage: self.ctx.storage, bucket: self.env.FILES, prefix: `drive/${self.ctx.id.toString()}/` };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/drive/")) {
      return servePreview(this.drive, request);
    }
    captureGeo(request);
    return driveScope.run(this.drive, () => super.fetch(request));
  }

  override webSocketMessage(...args: never[]): Promise<unknown> {
    return driveScope.run(this.drive, () => super.webSocketMessage(...args));
  }

  override webSocketClose(...args: never[]): Promise<unknown> {
    return driveScope.run(this.drive, () => super.webSocketClose(...args));
  }

  override webSocketError(...args: never[]): Promise<unknown> {
    return driveScope.run(this.drive, () => super.webSocketError(...args));
  }
}

type DONamespace = {
  idFromName(name: string): unknown;
  idFromString(id: string): unknown;
  get(id: unknown): { fetch(r: Request): Promise<Response> };
};

/** `/drive/<DO id>/<file id>` (see `previewPath`): routed by the DO id, no cookie needed. */
const PREVIEW_PATH = /^\/drive\/([0-9a-f]{64})\/f-[0-9a-f-]{36}$/;

export default {
  async fetch(request: Request, env: { HOME_SCREEN_DO: DONamespace }, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const visitor = visitorFrom(request);

    // Thumbnails come from the drive's own DO.
    if (request.method === "GET" && url.pathname.startsWith("/drive/")) {
      const driveId = PREVIEW_PATH.exec(url.pathname)?.[1];
      if (driveId) {
        let id: unknown;
        try {
          id = env.HOME_SCREEN_DO.idFromString(driveId);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        return env.HOME_SCREEN_DO.get(id).fetch(request);
      }
      if (!visitor) return new Response("Not found", { status: 404 });
      const stub = env.HOME_SCREEN_DO.get(env.HOME_SCREEN_DO.idFromName(`visitor:${visitor}`));
      return stub.fetch(request);
    }

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
