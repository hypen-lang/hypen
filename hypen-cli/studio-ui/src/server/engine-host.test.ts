import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StudioEngineHost } from "./engine-host";

describe("StudioEngineHost.status", () => {
  const dirs: string[] = [];
  const project = () => {
    const d = mkdtempSync(join(tmpdir(), "hypen-engine-host-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("is `starting` before bootstrap", () => {
    const host = new StudioEngineHost({ projectDir: project(), componentsDir: "src/components", entryName: "App" });
    expect(host.status()).toEqual({ state: "starting" });
  });

  test("is `unavailable` with no components directory", async () => {
    const host = new StudioEngineHost({ projectDir: project(), componentsDir: "src/components", entryName: "App" });
    await host.start();
    expect(host.status().state).toBe("unavailable");
    expect(host.status().reason).toContain("no components directory");
  });

  test("is `unavailable` when the entry component is missing", async () => {
    const dir = project();
    mkdirSync(join(dir, "src/components/Other"), { recursive: true });
    writeFileSync(join(dir, "src/components/Other/component.hypen"), 'Text("x")');
    const host = new StudioEngineHost({ projectDir: dir, componentsDir: "src/components", entryName: "App" });
    await host.start();
    expect(host.status()).toEqual({ state: "unavailable", reason: 'entry "App" not found' });
  });

  test("is `ready` once the entry is served", async () => {
    const dir = project();
    mkdirSync(join(dir, "src/components/App"), { recursive: true });
    writeFileSync(join(dir, "src/components/App/component.hypen"), 'module App { Text("@{state.title}") }');
    const host = new StudioEngineHost({ projectDir: dir, componentsDir: "src/components", entryName: "App" });
    await host.start();
    expect(host.status()).toEqual({ state: "ready" });
    expect(host.isReady()).toBe(true);
  });
});

describe("StudioEngineHost unresolved components", () => {
  // The deleted-component case itself (discovery dropping a removed
  // component on reload) is covered against the repo packages in
  // hypen-web/tests/remote-deleted-component.test.ts; this suite covers the
  // studio reporting on top of whatever @hypen-space/server is installed.
  test("a referenced-but-undefined component is reported; adding it clears the report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-engine-host-unresolved-"));
    const comps = join(dir, "src/components");
    try {
      mkdirSync(join(comps, "App"), { recursive: true });
      writeFileSync(join(comps, "App/component.hypen"), 'module App { Column { Text("Entry") Banner() } }');
      const reports: string[][] = [];
      const host = new StudioEngineHost({
        projectDir: dir,
        componentsDir: "src/components",
        entryName: "App",
        onUnresolvedComponents: (names) => reports.push(names),
      });
      await host.start();

      const open = async () => {
        const sent: any[] = [];
        const ws: any = { send: (m: string) => sent.push(JSON.parse(m)), close: () => {} };
        host.attachSession(ws);
        host.onMessage(ws, JSON.stringify({ type: "hello" }));
        await new Promise((r) => setTimeout(r, 300));
        return { ws, sent };
      };
      const text = (sent: any[]) => JSON.stringify(sent.filter((m) => m.type === "initialTree"));

      const a = await open();
      expect(text(a.sent)).toContain("Entry");
      expect(reports.at(-1)).toEqual(["Banner"]);
      host.onClose(a.ws);

      mkdirSync(join(comps, "Banner"), { recursive: true });
      writeFileSync(join(comps, "Banner/component.hypen"), 'Text("Banner here")');
      await host.reload();
      const b = await open();
      expect(text(b.sent)).toContain("Banner here");
      expect(reports.at(-1)).toEqual([]);
      host.onClose(b.ws);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("warns once per name per reload, reports every session", () => {
    const reports: string[][] = [];
    const host = new StudioEngineHost({
      projectDir: "/nonexistent",
      componentsDir: "src/components",
      entryName: "App",
      onUnresolvedComponents: (names) => reports.push(names),
    });
    const session = { engine: { getUnresolvedComponents: () => ["Home"] } };
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      host.reportUnresolved(session);
      host.reportUnresolved(session);
    } finally {
      console.warn = orig;
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('Component "Home" is referenced but not defined');
    expect(reports).toEqual([["Home"], ["Home"]]);
  });
});
