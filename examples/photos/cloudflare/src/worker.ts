/**
 * Hypen Photos on Cloudflare — a camera roll and photo library.
 *
 * Each visitor gets their own Durable Object, keyed by a random
 * `hypen_photos` cookie (HttpOnly, SameSite=Lax, so a cross-site page cannot
 * open a socket into someone else's library). The cookie is minted on the
 * first page load AND on the first WebSocket upgrade: when the app only ever
 * runs embedded in the home-screen launcher (`HypenApp("ws://…/ws")`), its
 * socket handshake is the only response the browser sees from this origin.
 *
 * The DO wraps every entry point in `libraryScope.run(…)` so the module's
 * handlers reach THIS DO's SQLite and R2 prefix, even across long `await`s on
 * a camera capture (see library.ts). `GET /p/<DO id>/<photo id>` serves the
 * image bytes from the same DO — sniffed image types only.
 *
 * The visitor's time zone (for "Today"/"Yesterday" and for dating photos that
 * carry no EXIF date) comes from `request.cf.timezone`, stamped into a header
 * by the worker because `request.cf` does not reliably survive the hop into
 * the DO.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import photos from "./photos";
import { resources } from "./icons";
import {
  PHOTO_PATH,
  libraryScope,
  servePhoto,
  type LibraryScope,
  type LibraryStorage,
  type PhotoBucket,
} from "./library";

const VISITOR_COOKIE = "hypen_photos";
const VISITOR_ID = /^[0-9a-f-]{36}$/;
const TZ_HEADER = "x-hypen-photos-tz";

function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_photos=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

function visitorCookie(id: string, url: URL): string {
  const secure = url.protocol === "https:" || url.protocol === "wss:" ? "; Secure" : "";
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
}

/** A plausible IANA zone name ("Europe/Lisbon"), else null. */
function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const worker = defineHypenWorker({
  module: photos,
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "PhotosDO",
  binding: "PHOTOS_DO",
  // One Durable Object per visitor. The worker below guarantees every
  // upgrade carries a visitor id (minting one when needed).
  getRoutingKey: (request) => {
    const visitor = visitorFrom(request);
    return visitor ? `visitor:${visitor}` : crypto.randomUUID();
  },
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Photos",
});

const BaseDO = worker.PhotosDO as unknown as {
  new (...args: never[]): {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(...args: never[]): Promise<unknown>;
    webSocketClose(...args: never[]): Promise<unknown>;
    webSocketError(...args: never[]): Promise<unknown>;
  };
};

type DOSelf = {
  ctx: {
    storage: LibraryStorage & { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
    id: { toString(): string };
  };
  env: { PHOTOS: PhotoBucket };
};

/** The library DO: every entry point runs inside this visitor's library scope. */
export class PhotosDO extends BaseDO {
  private timeZone: string | null = null;

  private async scope(): Promise<LibraryScope> {
    const self = this as unknown as DOSelf;
    if (this.timeZone === null) {
      // After hibernation the field is gone; the zone was saved at upgrade.
      this.timeZone = validTimeZone(await self.ctx.storage.get("timeZone")) ?? "UTC";
    }
    return {
      storage: self.ctx.storage,
      bucket: self.env.PHOTOS,
      prefix: `photos/${self.ctx.id.toString()}/`,
      timeZone: this.timeZone,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/p/")) {
      return servePhoto(await this.scope(), request);
    }
    const tz = validTimeZone(request.headers.get(TZ_HEADER));
    if (tz && tz !== this.timeZone) {
      this.timeZone = tz;
      await (this as unknown as DOSelf).ctx.storage.put("timeZone", tz);
    }
    const scope = await this.scope();
    return libraryScope.run(scope, () => super.fetch(request));
  }

  override async webSocketMessage(...args: never[]): Promise<unknown> {
    const scope = await this.scope();
    return libraryScope.run(scope, () => super.webSocketMessage(...args));
  }

  override async webSocketClose(...args: never[]): Promise<unknown> {
    const scope = await this.scope();
    return libraryScope.run(scope, () => super.webSocketClose(...args));
  }

  override async webSocketError(...args: never[]): Promise<unknown> {
    const scope = await this.scope();
    return libraryScope.run(scope, () => super.webSocketError(...args));
  }
}

type DONamespace = {
  idFromName(name: string): unknown;
  idFromString(id: string): unknown;
  get(id: unknown): { fetch(r: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: { PHOTOS_DO: DONamespace }, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    // Images come straight from the library's own DO (routed by its id, so
    // native shells without a cookie jar can load them too). Both ids are
    // random: the URL is an unguessable link to that one photo.
    if (request.method === "GET" && url.pathname.startsWith("/p/")) {
      const doId = PHOTO_PATH.exec(url.pathname)?.[1];
      if (!doId) return new Response("Not found", { status: 404 });
      let id: unknown;
      try {
        id = env.PHOTOS_DO.idFromString(doId);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      return env.PHOTOS_DO.get(id).fetch(request);
    }

    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    let visitor = visitorFrom(request);
    let minted: string | null = null;
    const headers = new Headers(request.headers);
    if (isUpgrade) {
      if (!visitor) {
        minted = visitor = crypto.randomUUID();
        headers.set("Cookie", [request.headers.get("Cookie"), `${VISITOR_COOKIE}=${visitor}`].filter(Boolean).join("; "));
      }
      const tz = validTimeZone((request as Request & { cf?: { timezone?: unknown } }).cf?.timezone);
      if (tz) headers.set(TZ_HEADER, tz);
      else headers.delete(TZ_HEADER);
      request = new Request(request, { headers });
    }

    const response = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response> | Response)(
      request,
      env,
      ctx,
    );

    // Socket opened without a cookie (e.g. first launch inside the launcher):
    // hand the minted id back on the handshake so the next socket finds the
    // same library.
    if (minted && response.status === 101) {
      const out = new Headers(response.headers);
      out.append("Set-Cookie", visitorCookie(minted, url));
      return new Response(null, {
        status: 101,
        headers: out,
        webSocket: (response as Response & { webSocket?: WebSocket | null }).webSocket ?? null,
      } as ResponseInit);
    }

    // First page load: mint the visitor id the next socket is routed on.
    const isPage = request.method === "GET" && (response.headers.get("content-type") ?? "").startsWith("text/html");
    if (!visitor && isPage) {
      const out = new Headers(response.headers);
      out.append("Set-Cookie", visitorCookie(crypto.randomUUID(), url));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
    }
    return response;
  },
};
