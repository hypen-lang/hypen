/**
 * Nested-router auto-wiring.
 *
 * When a per-route module's template itself contains a `Router { Route
 * ... }` block, the SDK's auto-wire flattens every discovered router's
 * routes — primary and nested — into a single `ManagedRouter` against
 * the session's one `HypenRouter`. Nested routes share the parent's
 * URL space; authors spell out the full path in each `Route(path:)`.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteServer } from "../packages/server/src/remote/server";
import {
  AsyncQueueTransport,
  type OutgoingMessage,
} from "../packages/server/src/remote/session";
import { app } from "../packages/core/src/app";

/**
 * Materialize a component tree on disk so `RemoteServer.source()` can
 * discover it. RemoteServer has no in-memory `.component(name, dsl)`
 * API, so tests that exercise multi-module templates pay the tmpfs
 * cost. Each entry becomes `<dir>/<name>/component.hypen`.
 */
function writeComponents(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hypen-nested-router-"));
  for (const [name, dsl] of Object.entries(entries)) {
    const sub = join(dir, name);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "component.hypen"), dsl);
  }
  return dir;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("nested-router auto-wiring", () => {
  test("nested Router in a discovered child template mounts its route target", async () => {
    // The canonical `.source()` shape: primary App declares its own
    // Router; Home is a separate `.hypen` file whose template has its
    // own nested Router { Route("/home/feed") { Feed() } }. Pre-fix
    // `discoverRouters(host.ui)` walked only App's IR — child
    // templates were invisible, so `/home/feed` never became a
    // registered route and Feed.onActivated never fired.
    const dir = writeComponents({
      App: `module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`,
      Home: `module Home {
        Column {
          Text("home-root")
          Router {
            Route(path: "/home/feed") { Feed() }
            Route(path: "/home/explore") { Explore() }
          }
        }
      }`,
      Feed: `module Feed { Text("feed-body") }`,
      Explore: `module Explore { Text("explore-body") }`,
      Settings: `module Settings { Text("settings-body") }`,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const primary = app
      .defineState<{ location: string }>({ location: "/" })
      .build();

    // Feed carries an `onActivated` probe — the strongest signal
    // available. `ManagedRouter.activate()` only fires onActivated
    // when a route is actually mounted, which in turn only happens
    // if `managed.addRoute("/home/feed", "Feed")` was called during
    // auto-wire. Weaker probes like `state.location` would mirror on
    // any `router.push` regardless of whether the nested route was
    // discovered, so they can't distinguish the bug from the fix.
    const feedActivations: string[] = [];
    app
      .module("Feed")
      .defineState({})
      .onActivated((_state, ctx) => {
        const path = ctx?.router?.getCurrentPath() ?? "(no router)";
        feedActivations.push(path);
      })
      .build();
    app.module("Home").defineState({}).build();
    app.module("Explore").defineState({}).build();
    app.module("Settings").defineState({}).build();

    const server = new RemoteServer()
      .app(app)
      .module("App", primary)
      .source(dir)
      .ui(`module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`);
    await server.prepare();
    cleanups.push(() => server.stop());

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });
    const reader = (async () => {
      for await (const msg of transport.stream()) {
        if (msg.type === "initialTree") break;
      }
    })();
    await session.receive({ type: "hello" });
    await reader;

    await session.receive({
      type: "dispatchAction",
      action: "router.push",
      payload: { to: "/home/feed" },
    });
    // Let the router subscribe callbacks + mount lifecycle settle.
    await new Promise((r) => queueMicrotask(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));

    expect(feedActivations).toContain("/home/feed");
    await session.destroy();
  });

  test("top-level routes still work alongside the flattened nested ones", async () => {
    // Guardrail for the nested-discovery pass: adding child-template
    // discovery must not shadow or break the primary's own routes.
    const dir = writeComponents({
      App: `module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`,
      Home: `module Home { Text("home-root") }`,
      Settings: `module Settings { Text("settings-body") }`,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const primary = app
      .defineState<{ location: string }>({ location: "/" })
      .build();
    const settingsActivations: string[] = [];
    app
      .module("Settings")
      .defineState({})
      .onActivated((_state, ctx) => {
        settingsActivations.push(ctx?.router?.getCurrentPath() ?? "");
      })
      .build();
    app.module("Home").defineState({}).build();

    const server = new RemoteServer()
      .app(app)
      .module("App", primary)
      .source(dir)
      .ui(`module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`);
    await server.prepare();
    cleanups.push(() => server.stop());

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });
    const reader = (async () => {
      for await (const msg of transport.stream()) {
        if (msg.type === "initialTree") break;
      }
    })();
    await session.receive({ type: "hello" });
    await reader;

    await session.receive({
      type: "dispatchAction",
      action: "router.push",
      payload: { to: "/settings" },
    });
    await new Promise((r) => queueMicrotask(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));

    expect(settingsActivations).toContain("/settings");
    await session.destroy();
  });

  test("pure-DSL route target discovered via .source() mounts without a sidecar module", async () => {
    // P1-B regression guard. `Settings/component.hypen` exists with
    // no sidecar `.ts`, so `loadDiscoveredComponents` builds an
    // anonymous `app.defineState({}).build()` — pre-fix, no name
    // passed meant the registry never saw "Settings", so
    // `pickComponent` returned null during auto-wire and the
    // `/settings` route was silently skipped. The fix passes the
    // component name into `defineState({}, { name })` so the
    // registry knows about it.
    const dir = writeComponents({
      App: `module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`,
      Home: `module Home { Text("home") }`,
      Settings: `module Settings { Text("settings") }`,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const primary = app
      .defineState<{ location: string }>({ location: "/" })
      .build();
    // NOTE: deliberately NOT pre-registering Home or Settings —
    // testing that pure-discovery is sufficient.

    const server = new RemoteServer()
      .app(app)
      .module("App", primary)
      .source(dir)
      .ui(`module App {
        Router {
          Route(path: "/") { Home() }
          Route(path: "/settings") { Settings() }
        }
      }`);
    await server.prepare();
    cleanups.push(() => server.stop());

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });
    const reader = (async () => {
      for await (const msg of transport.stream()) {
        if (msg.type === "initialTree") break;
      }
    })();
    await session.receive({ type: "hello" });
    await reader;

    // After server.prepare(), the registry must have picked up both
    // Settings and Home from discovery — otherwise pickComponent
    // would silently skip them during auto-wire.
    expect(app.has("Settings")).toBe(true);
    expect(app.has("Home")).toBe(true);

    await session.destroy();
  });
});
