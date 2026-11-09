/**
 * `syncUrlWithRouter` — the browser URL <-> server route sync shared by the
 * default web clients (TS RemoteServer, Go RemoteServer, Cloudflare generic
 * client). Driven against a fake engine and fake window/history/location.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  locationToPath,
  normalizeBase,
  pathToLocation,
  syncUrlWithRouter,
} from "../packages/core/src/remote/url-sync";

class FakeEngine {
  initialTree: Array<() => void> = [];
  state: Array<(s: unknown) => void> = [];
  dispatched: Array<{ name: string; payload: unknown }> = [];
  subscribes = 0;
  onInitialTree(cb: () => void) {
    this.initialTree.push(cb);
  }
  onStateUpdate(cb: (s: unknown) => void) {
    this.state.push(cb);
  }
  subscribeState() {
    this.subscribes++;
  }
  dispatchAction(name: string, payload?: unknown) {
    this.dispatched.push({ name, payload });
  }
  /** A new session: initial tree, then its state. */
  session(state: unknown) {
    this.initialTree.forEach((cb) => cb());
    this.emit(state);
  }
  emit(state: unknown) {
    this.state.forEach((cb) => cb(state));
  }
}

const saved: Record<string, unknown> = {};
let listeners: Array<() => void>;
let pushes: string[];
let fakeLocation: { pathname: string };

beforeEach(() => {
  for (const k of ["window", "location", "history"]) saved[k] = (globalThis as any)[k];
  listeners = [];
  pushes = [];
  fakeLocation = { pathname: "/" };
  (globalThis as any).window = {
    addEventListener: (type: string, cb: () => void) => {
      if (type === "popstate") listeners.push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      if (type === "popstate") listeners = listeners.filter((l) => l !== cb);
    },
  };
  (globalThis as any).location = fakeLocation;
  (globalThis as any).history = {
    pushState: (_s: unknown, _t: string, url: string) => {
      pushes.push(url);
      fakeLocation.pathname = url;
    },
  };
});

afterEach(() => {
  for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k];
});

function back(to: string) {
  fakeLocation.pathname = to;
  listeners.forEach((l) => l());
}

describe("syncUrlWithRouter", () => {
  test("pushes the route's path when the app navigates", () => {
    const engine = new FakeEngine();
    syncUrlWithRouter(engine);
    engine.session({ location: "/" });
    expect(engine.subscribes).toBe(1);
    engine.emit({ location: "/about" });
    expect(pushes).toEqual(["/about"]);
    engine.emit({ location: "/about" }); // unrelated state change
    expect(pushes).toEqual(["/about"]);
  });

  test("a deep link moves the router before showing anything", () => {
    fakeLocation.pathname = "/about";
    const container = { style: { visibility: "" } } as unknown as HTMLElement;
    const engine = new FakeEngine();
    syncUrlWithRouter(engine, { container });
    engine.session({ location: "/" });
    expect(engine.dispatched).toEqual([{ name: "router.replace", payload: { to: "/about" } }]);
    expect(container.style.visibility).toBe("hidden");
    engine.emit({ location: "/about" });
    expect(container.style.visibility).toBe("");
    expect(pushes).toEqual([]); // the URL was already right
  });

  test("back/forward replace the server route without pushing", () => {
    const engine = new FakeEngine();
    syncUrlWithRouter(engine);
    engine.session({ location: "/" });
    engine.emit({ location: "/about" });
    back("/");
    expect(engine.dispatched.at(-1)).toEqual({ name: "router.replace", payload: { to: "/" } });
    engine.emit({ location: "/" });
    expect(pushes).toEqual(["/about"]);
  });

  test("apps without state.location are left alone", () => {
    fakeLocation.pathname = "/about";
    const engine = new FakeEngine();
    syncUrlWithRouter(engine);
    engine.session({ count: 0 });
    back("/x");
    expect(engine.subscribes).toBe(0);
    expect(engine.dispatched).toEqual([]);
  });

  test("a mount prefix maps app routes under it", () => {
    fakeLocation.pathname = "/canvas/about";
    const engine = new FakeEngine();
    syncUrlWithRouter(engine, { base: "/canvas/" });
    engine.session({ location: "/" });
    expect(engine.dispatched).toEqual([{ name: "router.replace", payload: { to: "/about" } }]);
    engine.emit({ location: "/about" });
    engine.emit({ location: "/" });
    expect(pushes).toEqual(["/canvas"]);
  });

  test("each new session subscribes again and re-syncs to the URL", () => {
    const engine = new FakeEngine();
    syncUrlWithRouter(engine);
    engine.session({ location: "/" });
    engine.emit({ location: "/about" });
    engine.session({ location: "/" }); // reconnect to a fresh session
    expect(engine.subscribes).toBe(2);
    expect(engine.dispatched.at(-1)).toEqual({ name: "router.replace", payload: { to: "/about" } });
  });
});

describe("path helpers", () => {
  test("normalizeBase / locationToPath / pathToLocation", () => {
    expect(normalizeBase("")).toBe("");
    expect(normalizeBase("/")).toBe("");
    expect(normalizeBase("app/")).toBe("/app");
    expect(locationToPath("/x", "")).toBe("/x");
    expect(locationToPath("/", "/app")).toBe("/app");
    expect(locationToPath("/x", "/app")).toBe("/app/x");
    expect(pathToLocation("/app", "/app")).toBe("/");
    expect(pathToLocation("/app/x/y", "/app")).toBe("/x/y");
    expect(pathToLocation("/apple", "/app")).toBeNull();
  });
});
