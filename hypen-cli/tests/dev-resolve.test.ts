import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  findLocalCli,
  findPackageRoot,
  importFromProject,
  resolveFromProject,
} from "../src/dev-resolve";

const root = join(tmpdir(), `hypen-dev-resolve-${process.pid}-${Date.now()}`);

function writePkg(dir: string, pkg: object, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

beforeAll(() => {
  // A project with its own @hypen-space/cli and a fake @hypen-space/core.
  const project = join(root, "project");
  writePkg(project, { name: "project" });
  mkdirSync(join(project, "src", "components"), { recursive: true });
  writePkg(
    join(project, "node_modules/@hypen-space/cli"),
    { name: "@hypen-space/cli", version: "9.9.9", bin: { hypen: "./dist/bin/hypen.js" } },
    { "dist/bin/hypen.js": "" }
  );
  writePkg(
    join(project, "node_modules/@hypen-space/core"),
    { name: "@hypen-space/core", type: "module", exports: { ".": "./index.js" } },
    { "index.js": "export const which = 'project';" }
  );
  // A "global" CLI install elsewhere.
  writePkg(join(root, "global/node_modules/@hypen-space/cli"), {
    name: "@hypen-space/cli",
    version: "1.0.0",
    bin: { hypen: "./dist/bin/hypen.js" },
  });
  // A project whose node_modules cli is a symlink to the running CLI.
  const linked = join(root, "linked");
  mkdirSync(join(linked, "node_modules/@hypen-space"), { recursive: true });
  writePkg(join(root, "self"), { name: "@hypen-space/cli", bin: { hypen: "./bin.js" } }, { "bin.js": "" });
  symlinkSync(join(root, "self"), join(linked, "node_modules/@hypen-space/cli"));
  // No packages at all.
  mkdirSync(join(root, "empty"), { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findLocalCli", () => {
  test("finds the project's CLI from a nested directory", () => {
    const local = findLocalCli(
      join(root, "project/src/components"),
      join(root, "global/node_modules/@hypen-space/cli")
    );
    expect(local?.version).toBe("9.9.9");
    expect(local?.bin).toBe(join(root, "project/node_modules/@hypen-space/cli/dist/bin/hypen.js"));
  });

  test("returns null when the local CLI is the running one (symlinked)", () => {
    expect(findLocalCli(join(root, "linked"), join(root, "self"))).toBeNull();
  });

  test("returns null without a local CLI", () => {
    expect(findLocalCli(join(root, "empty"), null)).toBeNull();
  });
});

describe("findPackageRoot", () => {
  test("walks up to the named package", () => {
    expect(findPackageRoot(join(root, "self"), "@hypen-space/cli")).toBe(join(root, "self"));
    expect(findPackageRoot(join(root, "empty"), "@hypen-space/cli")).toBeNull();
  });
});

describe("importFromProject", () => {
  test("prefers the project's copy of a package", async () => {
    expect(resolveFromProject("@hypen-space/core", join(root, "project"))).toBe(
      join(root, "project/node_modules/@hypen-space/core/index.js")
    );
    const mod = await importFromProject<{ which: string }>(
      "@hypen-space/core",
      async () => ({ which: "cli" }),
      join(root, "project")
    );
    expect(mod.which).toBe("project");
  });

  test("falls back to the CLI's own copy", async () => {
    const mod = await importFromProject<{ which: string }>(
      "@hypen-space/core",
      async () => ({ which: "cli" }),
      join(root, "empty")
    );
    expect(mod.which).toBe("cli");
  });
});
