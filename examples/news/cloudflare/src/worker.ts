/**
 * Hypen News on Cloudflare — Wikipedia's front page and live Hacker News.
 *
 * Two Durable Object classes:
 *
 *   - NewsDO (the Hypen DO, one per visitor) runs the app's sessions. Each
 *     visitor is routed by a random `hypen_news` cookie, so their saved
 *     stories and read history live in their own DO storage. The cookie is
 *     minted on the first page load OR the first WebSocket upgrade (the app
 *     is usually embedded in the home-screen launcher via `HypenApp(...)`, in
 *     which case the browser never loads this worker's page).
 *   - NewsHub (one instance, named "hub") owns every upstream request and
 *     the shared response cache — see hub.ts.
 *
 * NewsDO wraps each entry point in `visitorScope.run({ storage, hub }, …)` so
 * module handlers reach THIS visitor's storage via AsyncLocalStorage, even
 * across `await`s and from the polling timers they start (see scope.ts).
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
import bottomNav from "./components/BottomNav";
import today from "./components/Today";
import hacker from "./components/Hacker";
import story from "./components/Story";
import onThisDay from "./components/OnThisDay";
import saved from "./components/Saved";
import article from "./components/Article";
import { resources } from "./icons";
import { visitorScope, type VisitorScope, type VisitorStorage } from "./scope";
import type { HubStub } from "./hub";

export { NewsHub } from "./hub";

// Screen modules register on the shared `app` registry as an import side effect.
void today;
void hacker;
void story;
void onThisDay;
void saved;
void article;

const VISITOR_COOKIE = "hypen_news";
const VISITOR_HEADER = "x-hypen-news-visitor";
const VISITOR_ID = /^[0-9a-f-]{36}$/;

function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_news=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

const worker = defineHypenWorker({
  module: appModule,
  template: appModule.template ?? "",
  moduleName: "App",
  app,
  componentTemplates: {
    BottomNav: (bottomNav as { template?: string }).template ?? "",
  },
  resources,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "NewsDO",
  binding: "NEWS_DO",
  // One DO per visitor; the fetch handler below guarantees the header.
  getRoutingKey: (request) => `visitor:${request.headers.get(VISITOR_HEADER) ?? crypto.randomUUID()}`,
  clients: {
    "/": { js: genericClientJs as string, renderer: "dom" },
    "/canvas": { js: genericClientJs as string, renderer: "canvas" },
  },
  title: "Hypen News",
});

type HubNamespace = { idFromName(name: string): unknown; get(id: unknown): HubStub };
interface Env {
  NEWS_DO: unknown;
  NEWS_HUB: HubNamespace;
}

const BaseDO = worker.NewsDO as unknown as {
  new (...args: never[]): {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(...args: never[]): Promise<unknown>;
    webSocketClose(...args: never[]): Promise<unknown>;
    webSocketError(...args: never[]): Promise<unknown>;
  };
};

/** The Hypen DO with every entry point running inside this visitor's scope. */
export class NewsDO extends BaseDO {
  private get scope(): VisitorScope {
    const self = this as unknown as { ctx: { storage: VisitorStorage }; env: Env };
    const hubNs = self.env.NEWS_HUB;
    return { storage: self.ctx.storage, hub: hubNs.get(hubNs.idFromName("hub")) };
  }

  override fetch(request: Request): Promise<Response> {
    return visitorScope.run(this.scope, () => super.fetch(request));
  }

  override webSocketMessage(...args: never[]): Promise<unknown> {
    return visitorScope.run(this.scope, () => super.webSocketMessage(...args));
  }

  override webSocketClose(...args: never[]): Promise<unknown> {
    return visitorScope.run(this.scope, () => super.webSocketClose(...args));
  }

  override webSocketError(...args: never[]): Promise<unknown> {
    return visitorScope.run(this.scope, () => super.webSocketError(...args));
  }
}

function withCookie(response: Response, visitor: string, secure: boolean): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${VISITOR_COOKIE}=${visitor}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  const init: ResponseInit & { webSocket?: unknown } = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  const ws = (response as Response & { webSocket?: unknown }).webSocket;
  if (ws) init.webSocket = ws;
  return new Response(response.status === 101 ? null : response.body, init as ResponseInit);
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const existing = visitorFrom(request);
    const visitor = existing ?? crypto.randomUUID();

    const headers = new Headers(request.headers);
    headers.set(VISITOR_HEADER, visitor);
    const routed = new Request(request, { headers });

    const response = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      routed,
      env,
      ctx,
    );

    // First contact (a page load, or an embed's socket): mint the visitor id
    // the next connection routes on.
    const isPage = (response.headers.get("content-type") ?? "").startsWith("text/html");
    if (!existing && (isPage || response.status === 101)) {
      return withCookie(response, visitor, url.protocol === "https:");
    }
    return response;
  },
};
