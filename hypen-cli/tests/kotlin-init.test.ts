import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKotlinProject } from "../src/init/kotlin";
import pkg from "../package.json";

test.each(["file-based", "server-based"] as const)(
  "Kotlin %s scaffold pins its tested SDK version",
  (layout) => {
    const projectDir = mkdtempSync(join(tmpdir(), "hypen-kotlin-init-"));
    try {
      generateKotlinProject({ projectDir, projectName: "sample", layout });
      const gradle = readFileSync(join(projectDir, "build.gradle.kts"), "utf8");
      // The scaffold pins the SDK released with this CLI, never a floating version.
      expect(gradle).toContain(`implementation("space.hypen:hypen-kotlin:${pkg.version}")`);
      expect(gradle).not.toContain('implementation("space.hypen:hypen-kotlin:latest.release")');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
