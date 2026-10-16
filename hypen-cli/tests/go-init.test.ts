import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGoProject } from "../src/init/go";

test.each(["file-based", "server-based"] as const)(
  "Go %s scaffold imports the published monorepo module",
  (layout) => {
    const projectDir = mkdtempSync(join(tmpdir(), "hypen-go-init-"));
    try {
      generateGoProject({ projectDir, projectName: "sample", layout });
      const main = readFileSync(join(projectDir, "main.go"), "utf8");
      expect(main).toContain('core "github.com/hypen-lang/hypen/hypen-golang"');
      expect(main).toContain('"github.com/hypen-lang/hypen/hypen-golang/remote"');
      expect(main).not.toContain("github.com/hypen-space/core");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
