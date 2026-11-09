/**
 * Hot reload semantics: `RemoteServer.reload()` refreshes discovery and
 * DISCONNECTS connected clients instead of re-rendering into live sessions
 * (in-place reconciliation left stale router-cached subtrees and dead
 * reactive wiring). A client reconnecting with its session id resumes the
 * suspended session: fresh templates and module code, and EVERY module's
 * saved state (primary, nested, route modules) restored automatically under
 * the state-shape rule (`mergeRestoredState`).
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
const fixtureDir = join(import.meta.dir, `.tmp-hot-reload-${process.pid}`);

function writeApp(marker: string, greeting: string): void {
  const appDir = join(fixtureDir, "App");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "component.ts"),
    `import { app } from "@hypen-space/core";
export default app
  .defineState({ greeting: "${greeting}" })
  .onAction("noop", () => {})
  .build();
`
  );
  writeFileSync(
    join(appDir, "component.hypen"),
    `module App { Column { Text("${marker} @{state.greeting}") } }`
  );
}

// Its own directory: module imports are cached per path, so sharing the
// other test's fixture paths can serve a stale module.
const routedDir = join(import.meta.dir, `.tmp-hot-reload-routed-${process.pid}`);

function writeRoutedApp(opts: {
  counterMarker: string;
  counterState?: string;
}): void {
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
  .defineState({ taps: 0 })
  .onAction("tap", ({ state }) => { state.taps += 1; })
  .build();
`,
    "Home/component.hypen": `module Home { Column { Text("Taps: @{state.taps}") } }`,
    "Counter/component.ts": `import { app } from "@hypen-space/core";
export default app
  .defineState(${opts.counterState ?? `{ count: 0, label: "n" }`})
  .onAction("inc", ({ state }) => { state.count += 1; })
  .build();
`,
    "Counter/component.hypen": `module Counter { Column { Text("${opts.counterMarker} @{state.count}") } }`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(routedDir, rel, ".."), { recursive: true });
    writeFileSync(join(routedDir, rel), text);
  }
}

async function connect(server: RemoteServer, sessionId?: string) {
  const transport = new AsyncQueueTransport();
  const messages: any[] = [];
  (async () => {
    for await (const m of transport.stream()) messages.push(m);
  })();
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello", ...(sessionId ? { sessionId } : {}) } as any);
  await session.ready;
  await new Promise((r) => setTimeout(r, 100));
  return { transport, messages, session };
}

const allText = (messages: any[]) => JSON.stringify(messages);
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("RemoteServer hot reload", () => {
  let routed: RemoteServer | null = null;
  beforeEach(() => {
    // Other suites register named modules (e.g. "Counter") in the shared
    // registry; route resolution must see only this fixture's modules.
    app.clear?.();
  });
  afterEach(() => {
    routed?.stop();
    routed = null;
    rmSync(routedDir, { recursive: true, force: true });
  });

  test("route-module state survives template-only AND module (.ts) reloads", async () => {
    writeRoutedApp({ counterMarker: "Count:" });
    const loaded = await loadDiscoveredComponents(await discoverComponents(routedDir));
    routed = new RemoteServer().module("App", loaded.get("App")!.module as any).source(routedDir);
    await routed.prepare();

    const a = await connect(routed);
    const sessionId = a.messages.find((m) => m.type === "sessionAck").sessionId;
    for (let i = 0; i < 2; i++) {
      await a.session.receive({ type: "dispatchAction", action: "__hypen_scoped:home:tap" } as any);
      await pause(50);
    }
    expect(allText(a.messages)).toContain("Taps: 2");

    // Template-only edit of Home's sibling while on Home: still 2.
    writeRoutedApp({ counterMarker: "Counter is" });
    await routed.reload();
    await a.session.destroy();
    const b = await connect(routed, sessionId);
    expect(b.messages.find((m) => m.type === "sessionAck").isRestored).toBe(true);
    expect(allText(b.messages.filter((m) => m.type === "initialTree"))).toContain("Taps: 2");

    // Navigate to Counter, +1, then edit Counter's TEMPLATE: value kept.
    await b.session.receive({ type: "dispatchAction", action: "router.push", payload: { to: "/counter" } } as any);
    await pause();
    await b.session.receive({ type: "dispatchAction", action: "__hypen_scoped:counter:inc" } as any);
    await pause();
    expect(allText(b.messages)).toContain("Counter is 1");
    writeRoutedApp({ counterMarker: "Value" });
    await routed.reload();
    await b.session.destroy();
    const c = await connect(routed, sessionId);
    const initialC = allText(c.messages.filter((m) => m.type === "initialTree"));
    expect(initialC).toContain("Value 1");

    // Edit Counter's MODULE: `label` changes kind (string → number) and a
    // key is added. `count` (same kind) keeps 1; `label` takes the new
    // initial; the new key starts at its initial value.
    writeRoutedApp({ counterMarker: "Value", counterState: `{ count: 0, label: 7, extra: true }` });
    await routed.reload();
    await c.session.destroy();
    const d = await connect(routed, sessionId);
    expect(allText(d.messages.filter((m) => m.type === "initialTree"))).toContain("Value 1");
    const snap = d.session.takeSnapshot();
    expect(snap.modules.counter).toEqual({ count: 1, label: 7, extra: true });
    // ...and Home (cached, never re-mounted since) still has its taps.
    expect(snap.modules.home).toEqual({ taps: 2 });
    await d.session.destroy();
  });

  let server: RemoteServer | null = null;

  beforeEach(() => {
    mkdirSync(fixtureDir, { recursive: true });
  });

  afterEach(() => {
    server?.stop();
    server = null;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("reload disconnects clients; reconnect resumes with new code and saved state", async () => {
    writeApp("v1", "hello");
    const loaded = await loadDiscoveredComponents(
      await discoverComponents(fixtureDir)
    );
    server = new RemoteServer()
      .module("App", loaded.get("App")!.module as any)
      .source(fixtureDir);
    await server.prepare();

    // Client A connects and mutates its state.
    const transportA = new AsyncQueueTransport();
    const messagesA: any[] = [];
    (async () => {
      for await (const m of transportA.stream()) messagesA.push(m);
    })();
    const sessionA = server.createSession(transportA, { helloGraceMs: null });
    await sessionA.receive({ type: "hello" } as any);
    await sessionA.ready;
    await new Promise((r) => setTimeout(r, 100));

    const initialA = messagesA.find((m) => m.type === "initialTree");
    expect(JSON.stringify(initialA.patches)).toContain("v1 hello");
    const sessionId = messagesA.find((m) => m.type === "sessionAck")!.sessionId;

    await sessionA.receive({
      type: "updateState",
      state: { greeting: "MUTATED" },
    } as any);
    await new Promise((r) => setTimeout(r, 200));

    // Edit both template and module on disk, then hot reload.
    writeApp("v2", "hello");
    await server.reload();

    // A's transport was closed so the client reconnects.
    expect((transportA as any).closed).toBe(true);
    // The websocket adapter destroys the session on close; mimic that.
    await sessionA.destroy();

    // Client "A" reconnects with its session id.
    const transportB = new AsyncQueueTransport();
    const messagesB: any[] = [];
    (async () => {
      for await (const m of transportB.stream()) messagesB.push(m);
    })();
    const sessionB = server.createSession(transportB, { helloGraceMs: null });
    await sessionB.receive({ type: "hello", sessionId } as any);
    await sessionB.ready;
    await new Promise((r) => setTimeout(r, 100));

    const ack = messagesB.find((m) => m.type === "sessionAck");
    expect(ack.isRestored).toBe(true);

    const initialB = messagesB.find((m) => m.type === "initialTree");
    const treeB = JSON.stringify(initialB.patches);
    // New template applied...
    expect(treeB).toContain("v2");
    // ...with the suspended state restored over the new initial state.
    expect(treeB).toContain("MUTATED");
    expect(treeB).not.toContain("v1");

    await sessionB.destroy();
  });
});
