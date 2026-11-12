/**
 * Hypen Messages on Cloudflare — real-time chat between visitors.
 *
 * Topology: every socket goes to ONE coordinator Durable Object (`hub:main`,
 * see `getRoutingKey`). Each socket is still its own Hypen session (own
 * module state, `syncActions` off); the DO additionally owns a `ChatHub`
 * (hub.ts) over its SQLite that every session registers with, and fan-out is
 * the hub mutating the live state of every interested session. README.md
 * explains why this beats a DO per room for this app.
 *
 * Identity: each visitor gets a random `hypen_msg` cookie (HttpOnly,
 * SameSite=Lax) — minted on the first page load, or on the WebSocket upgrade
 * itself when the app is embedded in the launcher via `HypenApp(...)` and the
 * visitor never loaded our page. The worker passes it to the DO as a header
 * (overwriting anything the client sent); the DO stamps it onto the socket's
 * hibernation attachment and runs every socket event inside `connScope`, so
 * handlers learn who is calling from the socket, never from client state.
 *
 * `GET /img/<id>` serves uploaded photos from the hub's SQLite.
 */

import { defineHypenWorker } from "@hypen-space/cf";
// @ts-ignore - Wrangler's CompiledWasm rule turns this into a WebAssembly.Module.
import wasmModule from "hypen-engine/hypen_engine_bg.wasm";
// @ts-ignore - The web-target glue exports initSync(module) and WasmEngine.
import * as wasm from "hypen-engine";
// @ts-ignore - Wrangler's Text rule imports the prebuilt generic client as a string.
import genericClientJs from "../node_modules/@hypen-space/cf/dist/client/generic.js";
import messages from "./messages";
import { ChatHub, type HubStorage } from "./hub";
import { connScope } from "./scope";

const VISITOR_COOKIE = "hypen_msg";
const VISITOR_ID = /^[0-9a-f-]{36}$/;
const VISITOR_HEADER = "X-Hypen-Msg-Visitor";
const TZ_HEADER = "X-Hypen-Msg-Tz";
const HUB_KEY = "hub:main";
const IMAGE_PATH = /^\/img\/([0-9a-f-]{36})$/;

function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_msg=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

function visitorCookie(id: string, secure: boolean): string {
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function validTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const worker = defineHypenWorker({
  module: messages,
  wasm: wasm as never,
  wasmModule: wasmModule as WebAssembly.Module,
  doClassName: "MessagesDO",
  binding: "MESSAGES_DO",
  // Every socket joins the same coordinator DO. (To shard by community,
  // derive the key from a path or subdomain instead.)
  getRoutingKey: () => HUB_KEY,
  clients: {
    "/": {
      js: genericClientJs as string,
      renderer: "dom",
    },
  },
  title: "Hypen Messages",
});

type Attachment = { msgVisitor?: string; msgTz?: string } & Record<string, unknown>;
type AttachableSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

function readAttachment(ws: WebSocket): Attachment {
  try {
    const v = (ws as AttachableSocket).deserializeAttachment?.();
    return v && typeof v === "object" ? (v as Attachment) : {};
  } catch {
    return {};
  }
}

const BaseDO = worker.MessagesDO as unknown as {
  new (...args: never[]): {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void>;
    webSocketError(ws: WebSocket, error: unknown): Promise<void>;
  };
};

export class MessagesDO extends BaseDO {
  private hubInstance: ChatHub | null = null;
  /** Serialises upgrades so a new socket is matched to ITS request's visitor. */
  private upgradeLock: Promise<unknown> = Promise.resolve();

  private get state(): { storage: HubStorage; getWebSockets(): WebSocket[] } {
    return (this as unknown as { ctx: { storage: HubStorage; getWebSockets(): WebSocket[] } }).ctx;
  }

  private get hub(): ChatHub {
    return (this.hubInstance ??= new ChatHub(this.state.storage));
  }

  private scoped<T>(ws: WebSocket, fn: () => T): T {
    const att = readAttachment(ws);
    // Sockets are always stamped at upgrade; the fallback only guards a
    // runtime without the attachment API (then each socket is a stranger).
    const visitorId = att.msgVisitor ?? fallbackVisitor(ws);
    return connScope.run({ hub: this.hub, key: ws, visitorId, tz: att.msgTz ?? "UTC" }, fn);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const img = request.method === "GET" ? IMAGE_PATH.exec(url.pathname) : null;
    if (img) return this.serveImage(img[1]!);

    const visitor = request.headers.get(VISITOR_HEADER);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !visitor) {
      return super.fetch(request);
    }
    const tz = request.headers.get(TZ_HEADER) ?? "UTC";
    const run = this.upgradeLock.then(async () => {
      const before = new Set(this.state.getWebSockets());
      const res = await super.fetch(request);
      for (const ws of this.state.getWebSockets()) {
        if (before.has(ws)) continue;
        try {
          (ws as AttachableSocket).serializeAttachment({ ...readAttachment(ws), msgVisitor: visitor, msgTz: tz });
        } catch {
          /* no attachment API — scoped() falls back */
        }
      }
      return res;
    });
    this.upgradeLock = run.catch(() => undefined);
    return run;
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.scoped(ws, () => super.webSocketMessage(ws, message));
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    return this.scoped(ws, () => super.webSocketClose(ws, code, reason));
  }

  override webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    return this.scoped(ws, () => super.webSocketError(ws, error));
  }

  private serveImage(id: string): Response {
    const row = this.hub.image(id);
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.bytes, {
      headers: {
        "Content-Type": row.type,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // The launcher embeds us from another origin.
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }
}

const fallbackIds = new WeakMap<WebSocket, string>();
function fallbackVisitor(ws: WebSocket): string {
  let id = fallbackIds.get(ws);
  if (!id) fallbackIds.set(ws, (id = crypto.randomUUID()));
  return id;
}

type DONamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(r: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: { MESSAGES_DO: DONamespace }, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && IMAGE_PATH.test(url.pathname)) {
      return env.MESSAGES_DO.get(env.MESSAGES_DO.idFromName(HUB_KEY)).fetch(new Request(request.url));
    }

    const existing = visitorFrom(request);
    const visitor = existing ?? crypto.randomUUID();
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isUpgrade) {
      const headers = new Headers(request.headers);
      headers.set(VISITOR_HEADER, visitor); // overwrite: never trust a client-sent value
      const cf = (request as Request & { cf?: { timezone?: unknown } }).cf;
      headers.set(TZ_HEADER, validTimeZone(cf?.timezone));
      const res = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
        new Request(request, { headers }),
        env,
        ctx,
      );
      // Embedded via HypenApp, the visitor may never have loaded our page:
      // mint the cookie on the handshake response itself.
      if (existing || res.status !== 101) return res;
      const out = new Headers(res.headers);
      out.append("Set-Cookie", visitorCookie(visitor, secure));
      return new Response(null, {
        status: 101,
        headers: out,
        webSocket: (res as Response & { webSocket?: WebSocket }).webSocket,
      } as ResponseInit & { webSocket?: WebSocket });
    }

    const headers = new Headers(request.headers);
    headers.delete(VISITOR_HEADER);
    headers.delete(TZ_HEADER);
    const res = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      new Request(request, { headers }),
      env,
      ctx,
    );
    const isPage = request.method === "GET" && (res.headers.get("content-type") ?? "").startsWith("text/html");
    if (existing || !isPage) return res;
    const out = new Headers(res.headers);
    out.append("Set-Cookie", visitorCookie(visitor, secure));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  },
};
