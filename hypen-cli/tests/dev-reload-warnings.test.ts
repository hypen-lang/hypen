/**
 * `hypen dev` hot reload prints the built-in-name warning ONCE per reload
 * (the watcher's rescan and `RemoteServer.reload()` both run discovery; each
 * pass used to warn), and framework "[Remote]"/"[Discovery]" tags honour
 * NO_COLOR.
 *
 * The fixture project links @hypen-space/{core,server} to this checkout's
 * packages, so `dev()` (which loads them from the project, like a real app)
 * exercises the in-tree code rather than the CLI's installed copies.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { dev } from "../src/dev-bun";

const repoPackages = join(import.meta.dir, "../../hypen-web/packages");
const fixture = join(import.meta.dir, `.tmp-dev-reload-warnings-${process.pid}`);
const components = join(fixture, "src/components");
const PORT = 5537;

const hasRepo = existsSync(join(repoPackages, "server/src/discovery.ts"));

function writeComponent(name: string, template: string): void {
  mkdirSync(join(components, name), { recursive: true });
  writeFileSync(join(components, name, "component.hypen"), template);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRepo)("hypen dev reload warnings", () => {
  const warns: string[] = [];
  const logs: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  const origCwd = process.cwd();
  const origNoColor = process.env.NO_COLOR;
  let stop: (() => void) | null = null;

  beforeAll(async () => {
    mkdirSync(join(fixture, "node_modules/@hypen-space"), { recursive: true });
    for (const pkg of ["core", "server"]) {
      symlinkSync(join(repoPackages, pkg), join(fixture, "node_modules/@hypen-space", pkg));
    }
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeComponent("App", `module App { Column { Text("Hello") } }`);
    process.env.NO_COLOR = "1";
    process.chdir(fixture);
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    const server = await dev({ components: "./src/components", entry: "App", port: PORT, hot: true });
    stop = server.stop;
    await sleep(300);
  });

  afterAll(() => {
    stop?.();
    console.warn = origWarn;
    console.log = origLog;
    process.chdir(origCwd);
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
    rmSync(fixture, { recursive: true, force: true });
  });

  const reloads = () => logs.filter((l) => l.includes("Reloaded")).length;
  const shadowWarnings = () => warns.filter((w) => w.includes("same name as the built-in"));

  async function waitForReload(after: number): Promise<void> {
    for (let i = 0; i < 100 && reloads() <= after; i++) await sleep(50);
    expect(reloads()).toBeGreaterThan(after);
    await sleep(200);
  }

  test("one built-in-name warning per reload, without ANSI colors under NO_COLOR", async () => {
    expect(shadowWarnings()).toHaveLength(0);

    let before = reloads();
    writeComponent("Badge", `Text("my badge")`);
    await waitForReload(before);
    expect(shadowWarnings()).toHaveLength(1);
    expect(shadowWarnings()[0]).toContain('"Badge"');
    expect(shadowWarnings()[0]).toStartWith("[Discovery]");
    expect(shadowWarnings()[0]).not.toContain("\x1b[");

    // A later, separate reload warns again — once.
    await sleep(3200);
    before = reloads();
    writeComponent("App", `module App { Column { Text("Hello again") } }`);
    await waitForReload(before);
    expect(shadowWarnings()).toHaveLength(2);
  }, 20000);
});
