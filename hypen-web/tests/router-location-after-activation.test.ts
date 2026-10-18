/**
 * The router → `state.location` mirror waits for ManagedRouter to activate
 * the target module, so the frame that first renders a route already carries
 * the state its `onActivated` wrote (e.g. a `.sharedElement` key), instead of
 * an empty/unresolved first frame followed by a separate setProp.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/server/src/remote/session";
import { app } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const UI = `module App {
  Router {
    Route(path: "/") { MirrorHome() }
    Route(path: "/story/:id") { MirrorStory() }
  }
}`;

describe("router → state.location mirror", () => {
  test("first frame of a route carries state written in onActivated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-loc-mirror-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const files: Record<string, string> = {
      App: UI,
      MirrorHome: `module MirrorHome { Text("HOME") }`,
      MirrorStory: `module MirrorStory { Text("STORY @{state.title}") }`,
    };
    for (const [name, dsl] of Object.entries(files)) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "component.hypen"), dsl);
    }

    const primary = app.defineState<{ location: string }>({ location: "/" }).build();
    app.module("MirrorHome").defineState({}).build();
    app
      .module("MirrorStory")
      .defineState<{ title: string | null }>({ title: null })
      .onActivated((state, ctx) => {
        state.title = `T-${ctx?.router?.getCurrentPath()?.split("/").pop()}`;
      })
      .build();

    const server = new RemoteServer().app(app).module("App", primary).source(dir).ui(UI);
    await server.prepare();
    cleanups.push(() => server.stop());

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });
    const frames: Patch[][] = [];
    let initSeen = false;
    (async () => {
      for await (const msg of transport.stream()) {
        if (msg.type === "initialTree") initSeen = true;
        else if (initSeen && msg.type === "patch") frames.push(msg.patches);
      }
    })().catch(() => {});
    await session.receive({ type: "hello" });
    await new Promise((r) => setTimeout(r, 10));

    await session.receive({ type: "dispatchAction", action: "router.push", payload: { to: "/story/s1" } });
    await new Promise((r) => setTimeout(r, 100));

    const texts = (p: Patch) =>
      p.type === "create" ? Object.values(p.props ?? {}) : p.type === "setProp" ? [p.value] : [];
    const first = frames.findIndex((f) => f.some((p) => texts(p).some((v) => String(v).startsWith("STORY"))));
    expect(first).toBeGreaterThanOrEqual(0);
    const storyTexts = frames[first]!.flatMap(texts).filter((v) => String(v).startsWith("STORY"));
    expect(storyTexts).toEqual(["STORY T-s1"]);
    expect((session.moduleInstance?.getState() as { location?: string }).location).toBe("/story/s1");

    await session.destroy();
  });
});
