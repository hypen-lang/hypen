import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKotlinProject } from "../src/init/kotlin";

test.each(["file-based", "server-based"] as const)(
  "Kotlin %s scaffold pins its tested SDK version",
  (layout) => {
    const projectDir = mkdtempSync(join(tmpdir(), "hypen-kotlin-init-"));
    try {
      generateKotlinProject({ projectDir, projectName: "sample", layout });
      const gradle = readFileSync(join(projectDir, "build.gradle.kts"), "utf8");
      expect(gradle).toContain('implementation("space.hypen:hypen-kotlin:0.6.6")');
      expect(gradle).not.toContain('implementation("space.hypen:hypen-kotlin:latest.release")');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
