/**
 * Hot reload semantics: `RemoteServer.reload()` refreshes discovery and
 * DISCONNECTS connected clients instead of re-rendering into live sessions
 * (in-place reconciliation left stale router-cached subtrees and dead
 * reactive wiring). A client reconnecting with its session id resumes the
 * suspended session: fresh templates and module code, saved primary-module
 * state restored automatically.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/core/src/remote/remote-session";
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

describe("RemoteServer hot reload", () => {
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
