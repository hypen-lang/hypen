/**
 * Router-swap regression — locks the property that broke a stale
 * Cloudflare deploy of examples/calorie-counter without triggering any
 * other test.
 *
 * The bug shape: dispatching `router.push` against the live worker
 * produced a single-patch frame (`setProp color` on the active BottomNav
 * tab) instead of a real route swap. The shell read `@state.location`
 * and reacted; the engine's `Router` IR didn't swap subtrees. That meant
 * `state.location` was updating but the Router IR was not.
 *
 * These tests prove the auto-wire produces BOTH effects on a single
 * `router.push`:
 *
 *   1. The Router IR swaps to the new route's component — strongest
 *      signal is its module's `onActivated` firing with the new path.
 *   2. The shell-state reactive binding (`@state.location` read from an
 *      anonymous component) re-evaluates in the SAME render cycle and
 *      emits patches.
 *
 * Without (1) the shell update from the stale deploy would still pass a
 * naive "did anything change?" assertion, so we assert both explicitly.
 * Without (2) we'd miss a separate regression where the shell binding
 * stops updating (the symptom users would notice as "tab highlight
 * doesn't move").
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/server/src/remote/session";
import { app } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";

function writeComponents(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hypen-router-swap-"));
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

/** Drain frames from the transport until `initialTree`, then return a
 * collector that yields any patches that arrive after the next await. */
async function setUpSession(server: RemoteServer) {
  const transport = new AsyncQueueTransport();
  const session = server.createSession(transport, { helloGraceMs: null });

  const post: { patches: Patch[]; revs: number[] } = { patches: [], revs: [] };
  let initSeen = false;
  // Background reader — captures every `patch` frame after `initialTree`.
  (async () => {
    for await (const msg of transport.stream()) {
      if (msg.type === "initialTree") {
        initSeen = true;
        continue;
      }
      if (initSeen && msg.type === "patch") {
        post.patches.push(...msg.patches);
        post.revs.push(msg.revision);
      }
    }
  })().catch(() => {});

  await session.receive({ type: "hello" });
  // Wait one micro+macro tick for initialTree to be queued.
  await new Promise((r) => queueMicrotask(() => r(null)));
  await new Promise((r) => setTimeout(r, 10));

  return { session, post };
}

describe("router.push emits a real route swap", () => {
  test(
    "swapping primary routes produces Create patches for the new route's children, not just a single setProp",
    async () => {
      // Two distinct route subtrees, each with a uniquely-tagged Text so we
      // can find new-route elements in the patch stream by content.
      const dir = writeComponents({
        App: `module App {
          Router {
            Route(path: "/") { Home() }
            Route(path: "/profile") { Profile() }
          }
        }`,
        Home: `module Home { Text("HOME_MARKER") }`,
        Profile: `module Profile { Text("PROFILE_MARKER") }`,
      });
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

      const primary = app
        .defineState<{ location: string }>({ location: "/" })
        .build();
      const homeActivations: string[] = [];
      const profileActivations: string[] = [];
      app
        .module("Home")
        .defineState({})
        .onActivated((_s, ctx) => homeActivations.push(ctx?.router?.getCurrentPath() ?? ""))
        .build();
      app
        .module("Profile")
        .defineState({})
        .onActivated((_s, ctx) => profileActivations.push(ctx?.router?.getCurrentPath() ?? ""))
        .build();

      const server = new RemoteServer()
        .app(app)
        .module("App", primary)
        .source(dir)
        .ui(`module App {
          Router {
            Route(path: "/") { Home() }
            Route(path: "/profile") { Profile() }
          }
        }`);
      await server.prepare();
      cleanups.push(() => server.stop());

      const { session, post } = await setUpSession(server);

      // Sanity: initial route activated Home, not Profile.
      expect(homeActivations).toContain("/");
      expect(profileActivations).toEqual([]);

      await session.receive({
        type: "dispatchAction",
        action: "router.push",
        payload: { to: "/profile" },
      });
      await new Promise((r) => queueMicrotask(() => r(null)));
      await new Promise((r) => setTimeout(r, 50));

      // 1. Profile.onActivated fired — proves Router IR + ManagedRouter
      //    actually mounted the new route. The stale-deploy bug would
      //    fail this assertion because the route never mounted.
      expect(profileActivations).toContain("/profile");

      // 2. The patch stream after the push contains a Create patch with
      //    `PROFILE_MARKER` somewhere in its props. (The marker is on a
      //    Text element; depending on engine convention it lives in
      //    props["0"] or props.text — we accept either.)
      const profileCreates = post.patches.filter((p) => {
        if (p.type !== "create") return false;
        const props = (p as Patch & { props?: Record<string, unknown> }).props ?? {};
        return Object.values(props).some(
          (v) => typeof v === "string" && v === "PROFILE_MARKER",
        );
      });
      expect(profileCreates.length).toBeGreaterThan(0);

      // 3. The stale-deploy bug emitted n=1 patches for the push. The
      //    correct behavior emits many — Detach for the old subtree plus
      //    Create/Insert for the new one. Be conservative: assert more
      //    than 1, more than just a setProp on the shell.
      const nonSetProp = post.patches.filter((p) => p.type !== "setProp");
      expect(nonSetProp.length).toBeGreaterThan(1);

      await session.destroy();
    },
  );

  test(
    "anonymous shell component reading @state.location reacts in the SAME push that mounts the new route",
    async () => {
      // Mirrors the calorie-counter shape: BottomNav is registered with bare
      // `app.defineState({})` so `@state.location` falls through to the
      // primary App scope. The Router lives next to it. The bug shape we're
      // guarding against: only the shell reacts, Router IR stays put.
      const dir = writeComponents({
        App: `module App {
          Column {
            Router {
              Route(path: "/") { Home() }
              Route(path: "/profile") { Profile() }
            }
            BottomNav()
          }
        }`,
        Home: `module Home { Text("HOME_MARKER") }`,
        Profile: `module Profile { Text("PROFILE_MARKER") }`,
        BottomNav: `Text("@{state.location}")
          .color("@{state.location == '/' ? '#ff0000' : '#0000ff'}")`,
      });
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

      const primary = app
        .defineState<{ location: string }>({ location: "/" })
        .build();
      const profileActivations: string[] = [];
      app.module("Home").defineState({}).build();
      app
        .module("Profile")
        .defineState({})
        .onActivated((_s, ctx) => profileActivations.push(ctx?.router?.getCurrentPath() ?? ""))
        .build();

      const server = new RemoteServer()
        .app(app)
        .module("App", primary)
        .source(dir)
        .ui(`module App {
          Column {
            Router {
              Route(path: "/") { Home() }
              Route(path: "/profile") { Profile() }
            }
            BottomNav()
          }
        }`);
      await server.prepare();
      cleanups.push(() => server.stop());

      const { session, post } = await setUpSession(server);

      await session.receive({
        type: "dispatchAction",
        action: "router.push",
        payload: { to: "/profile" },
      });
      await new Promise((r) => queueMicrotask(() => r(null)));
      await new Promise((r) => setTimeout(r, 50));

      // Shell-binding reaction: at least one setProp touching a `color`
      // prop should appear (the BottomNav text reading @state.location).
      const colorSetProps = post.patches.filter((p) => {
        if (p.type !== "setProp") return false;
        const name = (p as Patch & { name?: string }).name ?? "";
        return name === "color" || name.startsWith("color.");
      });
      expect(colorSetProps.length).toBeGreaterThan(0);

      // Router IR reaction: Profile activated AND Profile-subtree Create
      // patches present in the SAME push. This is the "stale-deploy" bug
      // condition that the test exists to catch — both must hold.
      expect(profileActivations).toContain("/profile");
      const profileCreates = post.patches.filter((p) => {
        if (p.type !== "create") return false;
        const props = (p as Patch & { props?: Record<string, unknown> }).props ?? {};
        return Object.values(props).some(
          (v) => typeof v === "string" && v === "PROFILE_MARKER",
        );
      });
      expect(profileCreates.length).toBeGreaterThan(0);

      await session.destroy();
    },
  );

  test(
    "state.location mirrors to the path passed to router.push",
    async () => {
      // Soft probe: even if Router IR / ManagedRouter were misbehaving,
      // the URL → state mirror must still update the primary module's
      // `location` so reactive shell bindings can re-evaluate.
      const dir = writeComponents({
        App: `module App { Router { Route(path: "/") { Home() } Route(path: "/x") { X() } } }`,
        Home: `module Home { Text("h") }`,
        X: `module X { Text("x") }`,
      });
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

      const primary = app
        .defineState<{ location: string }>({ location: "/" })
        .build();
      app.module("Home").defineState({}).build();
      app.module("X").defineState({}).build();

      const server = new RemoteServer()
        .app(app)
        .module("App", primary)
        .source(dir)
        .ui(`module App {
          Router {
            Route(path: "/") { Home() }
            Route(path: "/x") { X() }
          }
        }`);
      await server.prepare();
      cleanups.push(() => server.stop());

      const { session } = await setUpSession(server);

      await session.receive({
        type: "dispatchAction",
        action: "router.push",
        payload: { to: "/x" },
      });
      await new Promise((r) => queueMicrotask(() => r(null)));
      await new Promise((r) => setTimeout(r, 50));

      const state = session.moduleInstance?.getState() as { location?: string } | undefined;
      expect(state?.location).toBe("/x");

      await session.destroy();
    },
  );
});
