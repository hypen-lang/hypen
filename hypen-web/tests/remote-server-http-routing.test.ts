/**
 * RemoteServer HTTP surface vs. app routes (onboarding QA P1#9):
 *
 *   - page navigations to any app path get the HTML shell (SPA fallback),
 *     so deep links and reloads on `/counter` work;
 *   - internal endpoints live under `/__hypen__/`, so `/stats` / `/health`
 *     stay usable as app routes in a browser;
 *   - session stats are not public by default;
 *   - `router.replace` (what the web client sends for a deep link or a
 *     back/forward) moves `state.location` on the server.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { app } from "../packages/core/src/app";

const ROUTED_UI = `module App {
  Router {
    Route(path: "/") { Text("Home page") }
    Route(path: "/counter") { Text("Counter page") }
    Route(path: "/stats") { Text("Stats page") }
  }
}`;

function routedApp() {
  return app
    .defineState<{ location: string }>({ location: "/" })
    .onAction<{ to: string }>("navigate", ({ action, state }) => {
      if (action.payload?.to) state.location = action.payload.to;
    })
    .build();
}

const HTML = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

let server: RemoteServer | null = null;

afterEach(async () => {
  server?.stop();
  server = null;
  await new Promise((r) => setTimeout(r, 50));
});

async function start(port: number, configure?: (s: RemoteServer) => RemoteServer) {
  let s = new RemoteServer().module("App", routedApp()).ui(ROUTED_UI);
  if (configure) s = configure(s);
  server = s;
  await s.listen(port);
  return `http://127.0.0.1:${port}`;
}

describe("RemoteServer SPA fallback", () => {
  test("a browser navigation to an app path gets the HTML shell", async () => {
    const base = await start(4660);
    for (const path of ["/counter", "/stats", "/health", "/users/42"]) {
      const res = await fetch(base + path, { headers: HTML });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("/__hypen__/client.js");
    }
  });

  test("assets and non-HTML requests to unknown paths are 404s, not the shell", async () => {
    const base = await start(4661);
    expect((await fetch(base + "/logo.png", { headers: HTML })).status).toBe(404);
    expect((await fetch(base + "/__hypen__/nope", { headers: HTML })).status).toBe(404);
    const api = await fetch(base + "/counter", { headers: { accept: "application/json" } });
    expect(api.status).toBe(404);
    const post = await fetch(base + "/counter", { method: "POST", headers: HTML });
    expect(post.status).toBe(404);
  });

  test("webClient: false keeps the plain-text catch-all", async () => {
    const base = await start(4662, (s) => s.config({ webClient: false }));
    const res = await fetch(base + "/counter", { headers: HTML });
    expect(await res.text()).toBe("Hypen Remote Server");
  });
});

describe("RemoteServer internal endpoints", () => {
  test("health answers under /__hypen__/ and, for non-browser probes, at /health", async () => {
    const base = await start(4663);
    const reserved = await fetch(base + "/__hypen__/health");
    expect(reserved.status).toBe(200);
    expect(await reserved.json()).toEqual({ status: "ok", server: "hypen-remote" });
    const legacy = await fetch(base + "/health");
    expect(await legacy.text()).toBe("OK");
  });

  test("stats answer loopback callers by default", async () => {
    const base = await start(4664);
    for (const path of ["/__hypen__/stats", "/stats"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty("activeSessions");
    }
  });

  test("stats are hidden from proxied (non-local) requests unless exposeStats()", async () => {
    const proxied = { "x-forwarded-for": "203.0.113.7" };
    let base = await start(4665);
    expect((await fetch(base + "/__hypen__/stats", { headers: proxied })).status).toBe(404);
    expect((await fetch(base + "/stats", { headers: proxied })).status).toBe(404);
    server!.stop();
    server = null;

    base = await start(4666, (s) => s.exposeStats());
    const res = await fetch(base + "/__hypen__/stats", { headers: proxied });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("activeSessions");
  });

  test("exposeStats(false) turns the endpoint off even locally", async () => {
    const base = await start(4667, (s) => s.exposeStats(false));
    expect((await fetch(base + "/__hypen__/stats")).status).toBe(404);
  });
});

describe("router.replace drives state.location (deep links, back/forward)", () => {
  test("a session starting at / moves to the requested route", async () => {
    await start(4668);
    const ws = new WebSocket("ws://127.0.0.1:4668");
    const messages: any[] = [];
    const waitFor = (pred: (m: any) => boolean, ms = 5000) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), ms);
        const check = () => {
          const hit = messages.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else setTimeout(check, 10);
        };
        check();
      });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    await new Promise((r) => (ws.onopen = r));
    try {
      ws.send(JSON.stringify({ type: "hello" }));
      const initial = await waitFor((m) => m.type === "initialTree");
      expect(initial.state.location).toBe("/");
      ws.send(JSON.stringify({ type: "subscribeState" }));
      ws.send(
        JSON.stringify({ type: "dispatchAction", action: "router.replace", payload: { to: "/counter" } }),
      );
      const update = await waitFor((m) => m.type === "stateUpdate" && m.state.location === "/counter");
      expect(update.state.location).toBe("/counter");
      const patches = messages.filter((m) => m.type === "patch").flatMap((m) => m.patches);
      expect(JSON.stringify(patches)).toContain("Counter page");
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
