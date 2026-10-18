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
