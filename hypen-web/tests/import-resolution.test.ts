import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  ComponentResolver,
  type ImportStatement,
} from "../packages/core/src/resolver";

/**
 * Import resolution integration tests for the TypeScript SDK.
 *
 * Covers:
 * - Local file resolution (resolveLocal)
 * - Discovery integration (templates preserve imports)
 * - Multi-file app scenarios
 */
describe("Import Resolution", () => {
  describe("resolveLocal", () => {
    const testDir = `/tmp/hypen-import-test-${Date.now()}`;

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("resolves .hypen file from local path", async () => {
      writeFileSync(join(testDir, "Button.hypen"), `Text("Hello Button")`);

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Button" },
        source: { type: "local", path: "./Button" },
      };

      const result = await resolver.resolve(importStmt);

      expect(result.Button).toBeDefined();
      expect(result.Button.template).toBe(`Text("Hello Button")`);
    });

    test("resolves with explicit .hypen extension", async () => {
      writeFileSync(join(testDir, "Card.hypen"), `Text("Card")`);

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Card" },
        source: { type: "local", path: "./Card.hypen" },
      };

      const result = await resolver.resolve(importStmt);
      expect(result.Card).toBeDefined();
    });

    test("resolves named imports from local file", async () => {
      writeFileSync(join(testDir, "ui.hypen"), `Column { Text("UI") }`);

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "named", names: ["Button", "Card"] },
        source: { type: "local", path: "./ui" },
      };

      const result = await resolver.resolve(importStmt);

      expect(result.Button).toBeDefined();
      expect(result.Card).toBeDefined();
      expect(result.Button.template).toBe(`Column { Text("UI") }`);
    });

    test("resolves from nested directory", async () => {
      const subDir = join(testDir, "components", "ui");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "Badge.hypen"), `Text("Badge")`);

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Badge" },
        source: { type: "local", path: "./components/ui/Badge" },
      };

      const result = await resolver.resolve(importStmt);
      expect(result.Badge).toBeDefined();
      expect(result.Badge.template).toBe(`Text("Badge")`);
    });

    test("throws for missing file", async () => {
      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "NotFound" },
        source: { type: "local", path: "./NotFound" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow();
    });

    test("caches local resolved components", async () => {
      writeFileSync(join(testDir, "Widget.hypen"), `Text("Widget")`);

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Widget" },
        source: { type: "local", path: "./Widget" },
      };

      // First resolve
      await resolver.resolve(importStmt);

      // Delete file
      rmSync(join(testDir, "Widget.hypen"));

      // Second resolve should use cache
      const result = await resolver.resolve(importStmt);
      expect(result.Widget).toBeDefined();
    });

    test("no-cache mode reads fresh for local files", async () => {
      writeFileSync(join(testDir, "Fresh.hypen"), `Text("v1")`);

      const resolver = new ComponentResolver({
        baseDir: testDir,
        cache: false,
      });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Fresh" },
        source: { type: "local", path: "./Fresh" },
      };

      const v1 = await resolver.resolve(importStmt);
      expect(v1.Fresh.template).toBe(`Text("v1")`);

      // Update file
      writeFileSync(join(testDir, "Fresh.hypen"), `Text("v2")`);

      const v2 = await resolver.resolve(importStmt);
      expect(v2.Fresh.template).toBe(`Text("v2")`);
    });

    test("resolves stateless component (no .ts sibling)", async () => {
      writeFileSync(
        join(testDir, "Stateless.hypen"),
        `Text("No module")`
      );

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Stateless" },
        source: { type: "local", path: "./Stateless" },
      };

      const result = await resolver.resolve(importStmt);
      expect(result.Stateless).toBeDefined();
      expect(result.Stateless.module).toBeDefined(); // empty module object
      expect(result.Stateless.template).toBe(`Text("No module")`);
    });
  });

  describe("parseImports for multi-file apps", () => {
    test("parses imports from a multi-page app", () => {
      const source = `
        import { Header } from "./layout/header"
        import { Footer } from "./layout/footer"
        import { Sidebar } from "./layout/sidebar"
        import { MainContent } from "./pages/main"

        Column {
          Header()
          Row {
            Sidebar()
            MainContent()
          }
          Footer()
        }
      `;

      const imports = ComponentResolver.parseImports(source);

      expect(imports).toHaveLength(4);
      expect(imports[0]).toEqual({
        clause: { type: "named", names: ["Header"] },
        source: { type: "local", path: "./layout/header" },
      });
      expect(imports[1]).toEqual({
        clause: { type: "named", names: ["Footer"] },
        source: { type: "local", path: "./layout/footer" },
      });
      expect(imports[2]).toEqual({
        clause: { type: "named", names: ["Sidebar"] },
        source: { type: "local", path: "./layout/sidebar" },
      });
      expect(imports[3]).toEqual({
        clause: { type: "named", names: ["MainContent"] },
        source: { type: "local", path: "./pages/main" },
      });
    });

    test("parses router app imports", () => {
      const source = `
        import HomePage from "./pages/home"
        import AboutPage from "./pages/about"
        import { NotFoundPage } from "./pages/errors"

        Router {
          Route(path: "/") { HomePage() }
          Route(path: "/about") { AboutPage() }
          Route(path: "*") { NotFoundPage() }
        }
      `;

      const imports = ComponentResolver.parseImports(source);

      expect(imports).toHaveLength(3);
      expect(imports[0].clause).toEqual({
        type: "default",
        name: "HomePage",
      });
      expect(imports[1].clause).toEqual({
        type: "default",
        name: "AboutPage",
      });
      expect(imports[2].clause).toEqual({
        type: "named",
        names: ["NotFoundPage"],
      });
    });

    test("parses mixed local and URL imports", () => {
      const source = `
        import { Button } from "./components/ui"
        import RemoteWidget from "https://cdn.example.com/widget"
        import { Theme } from "../shared/theme"
      `;

      const imports = ComponentResolver.parseImports(source);

      expect(imports).toHaveLength(3);
      expect(imports[0].source).toEqual({
        type: "local",
        path: "./components/ui",
      });
      expect(imports[1].source).toEqual({
        type: "url",
        url: "https://cdn.example.com/widget",
      });
      expect(imports[2].source).toEqual({
        type: "local",
        path: "../shared/theme",
      });
    });
  });

  describe("discovery preserves imports", () => {
    const testDir = `/tmp/hypen-discovery-import-test-${Date.now()}`;

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("template files retain import statements", async () => {
      const templateWithImports = `import { Button } from "./ui"\n\nColumn { Button(text: "Click") }`;
      writeFileSync(
        join(testDir, "App.hypen"),
        templateWithImports
      );

      const resolver = new ComponentResolver({ baseDir: testDir });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "App" },
        source: { type: "local", path: "./App" },
      };

      const result = await resolver.resolve(importStmt);

      // Template should still contain import statements (not stripped)
      expect(result.App.template).toContain("import");
      expect(result.App.template).toContain("Button");
      expect(result.App.template).toContain("./ui");
    });
  });
});
