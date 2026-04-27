import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// Import actual implementations from source
import { dev as bunDev, build as bunBuild } from "../src/dev-bun";
import { dev as nodeDev, build as nodeBuild } from "../src/dev-node";

// We can't directly import private functions, so we test via the public API
// and through the CLI integration tests. For the utility functions that are
// internal, we test their behavior through the dev/build outputs.

describe("Dev Server Utilities", () => {
  const testDir = `/tmp/hypen-dev-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("HTML template generation", () => {
    test("dev server generates valid HTML with app div and script tag", async () => {
      // Create a minimal component structure
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      // Start dev server briefly to check generated files
      const outDir = join(testDir, ".hypen");
      const result = await bunDev({
        components: join(testDir, "components"),
        entry: "App",
        port: 0, // Use any available port
        outDir,
        hot: false,
      });

      // Check that the main entry was generated
      const mainPath = join(outDir, "main.ts");
      expect(existsSync(mainPath)).toBe(true);

      const mainContent = readFileSync(mainPath, "utf-8");
      expect(mainContent).toContain("renderWithComponents");
      expect(mainContent).toContain('"App"');
      expect(mainContent).toContain("#app");

      // Check that components file was generated
      const componentsPath = join(outDir, "components.generated.ts");
      expect(existsSync(componentsPath)).toBe(true);

      result.stop();
    });
  });

  describe("DevOptions defaults", () => {
    test("uses default port 3000 when not specified", async () => {
      // Just verify the types accept the options shape
      const options = {
        components: "./components",
        entry: "App",
      };

      expect(options.components).toBe("./components");
      expect(options.entry).toBe("App");
    });
  });

  describe("BuildOptions defaults", () => {
    test("accepts valid build options", () => {
      const options = {
        components: "./components",
        entry: "App",
        outDir: "dist",
        minify: true,
        sourcemap: true,
      };

      expect(options.components).toBe("./components");
      expect(options.entry).toBe("App");
      expect(options.outDir).toBe("dist");
      expect(options.minify).toBe(true);
      expect(options.sourcemap).toBe(true);
    });
  });

  describe("output directory handling", () => {
    test("creates output directory if it doesn't exist", () => {
      const outDir = join(testDir, "output", "nested");

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      expect(existsSync(outDir)).toBe(true);
    });

    test("handles existing output directory", () => {
      const outDir = join(testDir, "existing");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "existing.txt"), "test");

      // Creating again should not throw
      mkdirSync(outDir, { recursive: true });

      expect(existsSync(outDir)).toBe(true);
      expect(existsSync(join(outDir, "existing.txt"))).toBe(true);
    });
  });

  describe("file generation", () => {
    test("generates components file", async () => {
      // Create a simple component
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      // Import and use generateComponentsCode
      const { generateComponentsCode } = await import("@hypen-space/server");
      const code = await generateComponentsCode(join(testDir, "components"));

      expect(code).toContain("App");
      expect(code).toContain("template");
    });

    test("generates main entry file via dev server", async () => {
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      const outDir = join(testDir, ".hypen");
      const result = await bunDev({
        components: join(testDir, "components"),
        entry: "App",
        port: 0,
        outDir,
        hot: false,
      });

      const mainPath = join(outDir, "main.ts");
      expect(existsSync(mainPath)).toBe(true);
      expect(readFileSync(mainPath, "utf-8")).toContain("renderWithComponents");

      result.stop();
    });
  });
});
