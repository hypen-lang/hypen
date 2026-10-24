/**
 * `hypen init` Kotlin generator (src/init/kotlin.ts).
 *
 * The generated projects were built and run end to end (Gradle + the SDK jar
 * with its bundled native engine, a WebSocket client and the Android gallery
 * app: "Tap me" increments, "Go to Counter" navigates). These tests pin the parts of the
 * scaffold that made that work out of the box.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKotlinProject } from "../src/init/kotlin";

const root = mkdtempSync(join(tmpdir(), "hypen-init-kotlin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function generate(layout: "file-based" | "server-based", sdkVersion?: string) {
  const projectDir = join(root, `${layout}-${sdkVersion ?? "cli"}`);
  const log = console.log;
  console.log = () => {};
  try {
    generateKotlinProject({ projectDir, projectName: "My App", layout, sdkVersion });
  } finally {
    console.log = log;
  }
  const read = (rel: string) => readFileSync(join(projectDir, rel), "utf-8");
  return { projectDir, read };
}

describe("generateKotlinProject", () => {
  test("pins the SDK to the CLI version and resolves it from Maven Central only", () => {
    const { read } = generate("file-based");
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    const build = read("build.gradle.kts");
    expect(build).toContain(`implementation("space.hypen:hypen-kotlin:${pkg.version}")`);
    expect(build).not.toContain("latest.release");
    expect(build).toContain("mavenCentral()");
    expect(build).not.toContain("mavenLocal()");
    // No custom Hypen Maven repository: Central is the only one.
    expect(build).not.toMatch(/maven\s*[({]/);
  });

  test("an explicit sdkVersion wins", () => {
    const { read } = generate("server-based", "9.9.9");
    expect(read("build.gradle.kts")).toContain(`space.hypen:hypen-kotlin:9.9.9`);
    expect(read("README.md")).toContain("space.hypen:hypen-kotlin:9.9.9");
  });

  test("the bundled engine needs no native path; HYPEN_NATIVE_LIB_DIR is an optional override", () => {
    const { read } = generate("file-based", "1.0.0");
    const build = read("build.gradle.kts");
    // Optional override, applied only when set; no warning when it is not.
    expect(build).toContain(`System.getenv("HYPEN_NATIVE_LIB_DIR")`);
    expect(build).toMatch(/if \(hypenNativeLibDir != null\) \{\s*systemProperty\("jna\.library\.path"/);
    expect(build).not.toContain("logger.warn");
    expect(build).not.toContain("else {");
    const settings = read("settings.gradle.kts");
    expect(settings).toContain(`rootProject.name = "my-app"`);
    expect(settings).toContain(`System.getenv("HYPEN_KOTLIN_SDK")?.let { includeBuild(it) }`);
    expect(settings).toContain("For contributors");
    const readme = read("README.md");
    expect(readme).not.toContain("publishToMavenLocal");
    expect(readme).not.toContain("mavenLocal");
    expect(readme).toContain("bundles the");
    // The getting-started path comes before any contributor-only setup.
    expect(readme.indexOf("./gradlew run")).toBeLessThan(readme.indexOf("For contributors"));
    expect(readme.indexOf("HYPEN_NATIVE_LIB_DIR")).toBeGreaterThan(readme.indexOf("For contributors"));
    expect(readme).toContain("cargo build --release -p hypen-engine --features uniffi");
  });

  test("session setup failures are reported instead of closing silently", () => {
    const { read } = generate("server-based", "1.0.1");
    const main = read("src/main/kotlin/app/hypen/starter/Main.kt");
    expect(main).toContain("catch (e: Throwable)");
    expect(main).toContain("Hypen: failed to start a session");
  });

  test("layouts: file-based ships component files, server-based inlines templates", () => {
    const file = generate("file-based", "2.0.0");
    for (const name of ["App", "Home", "Counter"]) {
      expect(existsSync(join(file.projectDir, `components/${name}/component.hypen`))).toBe(true);
    }
    expect(file.read("src/main/kotlin/app/hypen/starter/Main.kt")).toContain(`watchComponents("./components")`);

    const server = generate("server-based", "2.0.0");
    expect(existsSync(join(server.projectDir, "components"))).toBe(false);
    const main = server.read("src/main/kotlin/app/hypen/starter/Main.kt");
    expect(main).toContain("ui(homeTemplate)");
    expect(main).toContain(`route("/", "App")`);
  });
});
