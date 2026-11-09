/**
 * Regression: a component deleted from disk while still referenced kept
 * rendering after `RemoteServer.reload()` — discovery MERGED into the
 * previous `_discoveredComponents` map (the deleted entry survived), and the
 * deleted module's self-registration in the shared HypenApp registry kept
 * resolving / mounting it. After the reload it must behave like an unknown
 * component (resolver miss → engine warning), and re-adding it must render
 * again.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/core/src/remote/remote-session";
import { app } from "../packages/core/src/app";

const fixtureDir = join(import.meta.dir, `.tmp-deleted-component-${process.pid}`);

function writeFile(rel: string, text: string): void {
  mkdirSync(join(fixtureDir, rel, ".."), { recursive: true });
  writeFileSync(join(fixtureDir, rel), text);
}

function writeApp(): void {
  writeFile(
    "App/component.ts",
    `import { app } from "@hypen-space/core";
export default app.defineState({ n: 0 }).build();
`
  );
  writeFile(
    "App/component.hypen",
    `module App { Column { Text("Entry") Banner() Greeter() } }`
  );
}

/** Template-only component (auto-stateless module). */
function writeBanner(): void {
  writeFile("Banner/component.hypen", `Text("Banner says hi")`);
}

/** Named module with a sidecar `.ts` (self-registers in the app registry). */
function writeGreeter(): void {
  writeFile(
    "Greeter/component.ts",
    `import { app } from "@hypen-space/core";
export default app
  .module("Greeter")
  .defineState({ who: "world" })
  .onAction("noop", () => {})
  .build();
`
  );
  writeFile("Greeter/component.hypen", `module Greeter { Text("Hello @{state.who}") }`);
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
  await new Promise((r) => setTimeout(r, 50));
  return { messages, session };
}

const treeText = (messages: any[]) =>
  JSON.stringify(messages.filter((m) => m.type === "initialTree"));

describe("RemoteServer reload with a deleted component", () => {
  let server: RemoteServer | null = null;

  beforeEach(async () => {
    app.clear?.();
    writeApp();
    writeBanner();
    writeGreeter();
    server = new RemoteServer().module("App").source(fixtureDir);
    await server.prepare();
  });

  afterEach(() => {
    server?.stop();
    server = null;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("deleted components stop resolving after reload; re-adding restores them", async () => {
    const a = await connect(server!);
    expect(treeText(a.messages)).toContain("Banner says hi");
    expect(treeText(a.messages)).toContain("Hello ");
    await a.session.destroy();

    rmSync(join(fixtureDir, "Banner"), { recursive: true, force: true });
    rmSync(join(fixtureDir, "Greeter"), { recursive: true, force: true });
    await server!.reload();

    const b = await connect(server!);
    const tree = treeText(b.messages);
    expect(tree).toContain("Entry");
    expect(tree).not.toContain("Banner says hi");
    expect(tree).not.toContain("Hello ");
    // Unknown-component behaviour: the engine records the resolver miss
    // (and warns once per name).
    expect(b.session.engine.getUnresolvedComponents().sort()).toEqual(["Banner", "Greeter"]);
    expect(app.has("Greeter")).toBe(false);
    await b.session.destroy();

    // Restore the very same files (the Greeter `.ts` may come back from the
    // ESM cache without re-running its self-registration).
    writeBanner();
    writeGreeter();
    await server!.reload();
    const c = await connect(server!);
    expect(treeText(c.messages)).toContain("Banner says hi");
    expect(treeText(c.messages)).toContain("Hello ");
    expect(c.session.engine.getUnresolvedComponents()).toEqual([]);
    expect(app.has("Greeter")).toBe(true);
  });

  test("a host-registered module of the same name is not dropped", async () => {
    const hostDef = app.module("Greeter").defineState({ who: "host" }).build();
    rmSync(join(fixtureDir, "Greeter"), { recursive: true, force: true });
    await server!.reload();
    expect(app.get("Greeter")).toBe(hostDef);
  });
});
