/**
 * Per-module state streaming (Studio's State panel / Timeline):
 *
 *   - `subscribeState { modules: true }` streams every module's state —
 *     primary, nested and route modules (active or cached) — as
 *     `stateUpdate.modules`, keyed by lowercase module id, including
 *     changes to a route module that the primary's state never sees.
 *   - `updateState { modules }` restores every listed module (time-travel),
 *     so the preview re-renders the selected snapshot.
 *   - Both are additive: a plain `subscribeState` / `updateState { state }`
 *     behaves exactly as before.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/core/src/remote/remote-session";
import { app } from "../packages/core/src/app";
import {
  discoverComponents,
  loadDiscoveredComponents,
} from "../packages/server/src/discovery";

// In-tree so the fixture's `@hypen-space/core` import resolves.
const fixtureDir = join(import.meta.dir, `.tmp-module-state-${process.pid}`);

function writeRoutedApp(): void {
  const files: Record<string, string> = {
    "App/component.ts": `import { app } from "@hypen-space/core";
export default app.defineState({ location: "/" }).build();
`,
    "App/component.hypen": `module App {
  Column {
    Router {
      Route(path: "/") { Home() }
      Route(path: "/counter") { Counter() }
    }
  }
}`,
    "Home/component.ts": `import { app } from "@hypen-space/core";
export default app
  .module("Home")
  .defineState({ taps: 0 })
  .onAction("tap", ({ state }) => { state.taps += 1; })
  .build();
`,
    "Home/component.hypen": `module Home { Column { Text("Taps: @{state.taps}") } }`,
    "Counter/component.ts": `import { app } from "@hypen-space/core";
export default app
  .module("Counter")
  .defineState({ count: 0 })
  .onAction("inc", ({ state }) => { state.count += 1; })
  .build();
`,
    "Counter/component.hypen": `module Counter { Column { Text("Count: @{state.count}") } }`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(fixtureDir, rel, ".."), { recursive: true });
    writeFileSync(join(fixtureDir, rel), text);
  }
}

async function connect(server: RemoteServer) {
  const transport = new AsyncQueueTransport();
  const messages: any[] = [];
  (async () => {
    for await (const m of transport.stream()) messages.push(m);
  })();
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello" } as any);
  await session.ready;
  await pause();
  return { transport, messages, session };
}

const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const lastModules = (messages: any[]) =>
  [...messages].reverse().find((m) => m.type === "stateUpdate" && m.modules)?.modules;
const patchText = (messages: any[]) =>
  JSON.stringify(messages.filter((m) => m.type === "patch" || m.type === "initialTree"));

describe("per-module state streaming", () => {
  let server: RemoteServer | null = null;

  beforeEach(async () => {
    app.clear?.();
    writeRoutedApp();
    const loaded = await loadDiscoveredComponents(await discoverComponents(fixtureDir));
    server = new RemoteServer().module("App", loaded.get("App")!.module as any).source(fixtureDir);
    await server.prepare();
  });

  afterEach(() => {
    server?.stop();
    server = null;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("modules subscription streams route-module state keyed by module id", async () => {
    const c = await connect(server!);
    await c.session.receive({ type: "subscribeState", modules: true } as any);
    await pause();
    // An immediate snapshot on subscribe.
    expect(lastModules(c.messages)).toEqual({ app: { location: "/" }, home: { taps: 0 } });

    for (let i = 0; i < 2; i++) {
      await c.session.receive({ type: "dispatchAction", action: "__hypen_scoped:home:tap" } as any);
      await pause();
    }
    expect((lastModules(c.messages) as any).home.taps).toBe(2);
    // One update per change, no duplicates from the render + change paths.
    const tapsSeen = c.messages
      .filter((m) => m.type === "stateUpdate" && m.modules)
      .map((m) => m.modules.home.taps);
    expect(tapsSeen).toEqual([0, 1, 2]);
    // Legacy field still carries the primary's state.
    const last = [...c.messages].reverse().find((m) => m.type === "stateUpdate");
    expect(last.state).toEqual({ location: "/" });

    // Navigate: the cached Home stays in the map next to the active Counter.
    await c.session.receive({ type: "dispatchAction", action: "router.push", payload: { to: "/counter" } } as any);
    await pause(150);
    await c.session.receive({ type: "dispatchAction", action: "__hypen_scoped:counter:inc" } as any);
    await pause();
    expect(lastModules(c.messages)).toEqual({
      app: { location: "/counter" },
      home: { taps: 2 },
      counter: { count: 1 },
    });
  });

  test("a subscription sent before the initial tree still gets the route module", async () => {
    const transport = new AsyncQueueTransport();
    const messages: any[] = [];
    (async () => {
      for await (const m of transport.stream()) messages.push(m);
    })();
    const session = server!.createSession(transport, { helloGraceMs: null });
    const hello = session.receive({ type: "hello" } as any);
    await session.receive({ type: "subscribeState", modules: true } as any);
    await hello;
    await session.ready;
    await pause(150);
    expect(lastModules(messages)).toEqual({ app: { location: "/" }, home: { taps: 0 } });
  });

  test("updateState { modules } restores every module and re-renders (time-travel)", async () => {
    const c = await connect(server!);
    await c.session.receive({ type: "subscribeState", modules: true } as any);
    for (let i = 0; i < 2; i++) {
      await c.session.receive({ type: "dispatchAction", action: "__hypen_scoped:home:tap" } as any);
      await pause();
    }
    expect(patchText(c.messages)).toContain("Taps: 2");

    const before = c.messages.length;
    await c.session.receive({
      type: "updateState",
      module: "App",
      state: { location: "/" },
      modules: { app: { location: "/" }, home: { taps: 1 } },
    } as any);
    await pause();
    const after = c.messages.slice(before);
    expect(patchText(after)).toContain("Taps: 1");
    expect((lastModules(c.messages) as any).home.taps).toBe(1);
    expect(c.session.moduleStates()).toEqual({ app: { location: "/" }, home: { taps: 1 } });
  });

  test("time-travel across a navigation restores the route too", async () => {
    const c = await connect(server!);
    await c.session.receive({ type: "subscribeState", modules: true } as any);
    await c.session.receive({ type: "dispatchAction", action: "__hypen_scoped:home:tap" } as any);
    await pause();
    await c.session.receive({ type: "dispatchAction", action: "router.push", payload: { to: "/counter" } } as any);
    await pause(150);
    expect(patchText(c.messages)).toContain("Count: 0");

    const before = c.messages.length;
    await c.session.receive({
      type: "updateState",
      module: "App",
      state: { location: "/" },
      modules: { app: { location: "/" }, home: { taps: 0 } },
    } as any);
    await pause(150);
    expect(patchText(c.messages.slice(before))).toContain("Taps: 0");
  });

  test("legacy subscribeState: no modules field, one stateUpdate per patch", async () => {
    const c = await connect(server!);
    await c.session.receive({ type: "subscribeState" } as any);
    await pause();
    await c.session.receive({ type: "dispatchAction", action: "__hypen_scoped:home:tap" } as any);
    await pause();
    const updates = c.messages.filter((m) => m.type === "stateUpdate");
    const patches = c.messages.filter((m) => m.type === "patch");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBe(patches.length);
    for (const u of updates) expect(u.modules).toBeUndefined();

    // Legacy updateState (state only) still patches the primary.
    await c.session.receive({ type: "updateState", module: "App", state: { location: "/counter" } } as any);
    await pause(150);
    expect(patchText(c.messages)).toContain("Count: 0");
  });
});
