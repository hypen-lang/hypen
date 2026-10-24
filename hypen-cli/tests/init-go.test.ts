/**
 * `hypen init` Go generator (src/init/go.ts).
 *
 * The SDK is the subdirectory module github.com/hypen-lang/hypen/hypen-golang,
 * tagged `hypen-golang/vX.Y.Z` in lockstep with the CLI. These tests pin the
 * module path, the version pin and the import alias the scaffold relies on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GO_SDK_MODULE, generateGoProject } from "../src/init/go";

const root = mkdtempSync(join(tmpdir(), "hypen-init-go-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function generate(layout: "file-based" | "server-based", sdkVersion?: string) {
  const projectDir = join(root, `${layout}-${sdkVersion ?? "cli"}`);
  const log = console.log;
  console.log = () => {};
  try {
    mkdirSync(projectDir, { recursive: true });
    generateGoProject({ projectDir, projectName: "My App", layout, sdkVersion });
  } finally {
    console.log = log;
  }
  const read = (rel: string) => readFileSync(join(projectDir, rel), "utf-8");
  return { projectDir, read };
}

describe("generateGoProject", () => {
  test("module path is the monorepo subdirectory module", () => {
    expect(GO_SDK_MODULE).toBe("github.com/hypen-lang/hypen/hypen-golang");
  });

  test("go.mod requires the SDK at the CLI version, with a commented replace", () => {
    const { read } = generate("file-based");
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    const mod = read("go.mod");
    expect(mod).toContain("module my-app");
    expect(mod).toContain(`require ${GO_SDK_MODULE} v${pkg.version}\n`);
    expect(mod).toContain(`// replace ${GO_SDK_MODULE} => `);
    expect(mod).not.toMatch(/^replace /m);
    expect(mod).not.toContain("hypen-space/core");
  });

  test("an explicit sdkVersion wins and a leading v is normalised", () => {
    const { read } = generate("server-based", "v9.9.9");
    expect(read("go.mod")).toContain(`require ${GO_SDK_MODULE} v9.9.9\n`);
    expect(read("README.md")).toContain(`${GO_SDK_MODULE}\` v9.9.9`);
  });

  for (const layout of ["file-based", "server-based"] as const) {
    test(`${layout}: main.go imports the SDK as \`core\` plus /remote`, () => {
      const { read, projectDir } = generate(layout, "1.0.0");
      const main = read("main.go");
      expect(main).toContain(`\tcore "${GO_SDK_MODULE}"\n`);
      expect(main).toContain(`\t"${GO_SDK_MODULE}/remote"\n`);
      expect(main).toContain("core.NewApp(");
      expect(main).not.toContain("hypen-space/core");
      expect(existsSync(join(projectDir, "components/App/component.hypen"))).toBe(
        layout === "file-based",
      );
    });
  }
});
