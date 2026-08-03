import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import {
  discoverComponents,
  generateComponentsCode,
  watchComponents,
  type DiscoveredComponent,
} from "../packages/server/src/discovery";

describe("Component Discovery", () => {
  const testDir = `/tmp/hypen-discovery-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("discoverComponents", () => {
    test("discovers folder-based components", async () => {
      // Create Counter/component.ts + component.hypen
      const counterDir = join(testDir, "Counter");
      mkdirSync(counterDir, { recursive: true });
      writeFileSync(join(counterDir, "component.ts"), "export default {}");
      writeFileSync(join(counterDir, "component.hypen"), "Text('Counter')");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("Counter");
      expect(components[0].hasModule).toBe(true);
      expect(components[0].template).toBe("Text('Counter')");
    });

    test("discovers sibling-based components", async () => {
      // Create Button.ts + Button.hypen
      writeFileSync(join(testDir, "Button.ts"), "export default {}");
      writeFileSync(join(testDir, "Button.hypen"), "Text('Button')");

      const components = await discoverComponents(testDir, {
        patterns: ["sibling"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("Button");
      expect(components[0].hasModule).toBe(true);
    });

    test("discovers index-based components", async () => {
      // Create Card/index.ts + index.hypen
      const cardDir = join(testDir, "Card");
      mkdirSync(cardDir, { recursive: true });
      writeFileSync(join(cardDir, "index.ts"), "export default {}");
      writeFileSync(join(cardDir, "index.hypen"), "Text('Card')");

      const components = await discoverComponents(testDir, {
        patterns: ["index"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("Card");
      expect(components[0].hasModule).toBe(true);
    });

    test("discovers stateless components (no .ts file)", async () => {
      // Create Footer/component.hypen without component.ts
      const footerDir = join(testDir, "Footer");
      mkdirSync(footerDir, { recursive: true });
      writeFileSync(join(footerDir, "component.hypen"), "Text('Footer')");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("Footer");
      expect(components[0].hasModule).toBe(false);
      expect(components[0].modulePath).toBeNull();
    });

    test("discovers multiple components", async () => {
      // Create multiple components
      const components_to_create = ["Header", "Footer", "Sidebar"];
      for (const name of components_to_create) {
        const dir = join(testDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "component.ts"), "export default {}");
        writeFileSync(join(dir, "component.hypen"), `Text('${name}')`);
      }

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(3);
      const names = components.map((c) => c.name);
      expect(names).toContain("Header");
      expect(names).toContain("Footer");
      expect(names).toContain("Sidebar");
    });

    test("preserves import statements in templates", async () => {
      const counterDir = join(testDir, "Counter");
      mkdirSync(counterDir, { recursive: true });
      writeFileSync(join(counterDir, "component.ts"), "export default {}");
      writeFileSync(
        join(counterDir, "component.hypen"),
        `import Button from "./Button"
Text('Counter')`
      );

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      // Imports are now preserved — engine processes them via parse_document
      expect(components[0].template).toContain("import");
      expect(components[0].template).toContain("Text('Counter')");
    });

    test("returns empty array for empty directory", async () => {
      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toEqual([]);
    });

    test("skips directories without .hypen files", async () => {
      // Create directory with only .ts file
      const partialDir = join(testDir, "Partial");
      mkdirSync(partialDir, { recursive: true });
      writeFileSync(join(partialDir, "component.ts"), "export default {}");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(0);
    });

    test("skips component.hypen and index.hypen in sibling pattern", async () => {
      // These should be handled by folder/index patterns, not sibling
      const dir = join(testDir, "Test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.hypen"), "Text('component')");
      writeFileSync(join(dir, "index.hypen"), "Text('index')");

      const components = await discoverComponents(testDir, {
        patterns: ["sibling"],
        recursive: true,
      });

      expect(components).toHaveLength(0);
    });

    test("uses all patterns by default", async () => {
      // Create folder-based
      const folderDir = join(testDir, "Folder");
      mkdirSync(folderDir, { recursive: true });
      writeFileSync(join(folderDir, "component.hypen"), "Text('Folder')");

      // Create sibling-based
      writeFileSync(join(testDir, "Sibling.hypen"), "Text('Sibling')");

      const components = await discoverComponents(testDir);

      expect(components.length).toBeGreaterThanOrEqual(2);
      const names = components.map((c) => c.name);
      expect(names).toContain("Folder");
      expect(names).toContain("Sibling");
    });

    test("avoids duplicate components", async () => {
      // Create component that could match multiple patterns
      const dir = join(testDir, "Dup");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.hypen"), "Text('Dup')");
      writeFileSync(join(dir, "component.ts"), "export default {}");

      const components = await discoverComponents(testDir, {
        patterns: ["folder", "folder"], // Try to match twice
      });

      // Should only have one component
      expect(components.filter((c) => c.name === "Dup")).toHaveLength(1);
    });
  });

  describe("generateComponentsCode", () => {
    test("generates code for discovered components", async () => {
      // Create a component
      const counterDir = join(testDir, "Counter");
      mkdirSync(counterDir, { recursive: true });
      writeFileSync(join(counterDir, "component.ts"), "export default {}");
      writeFileSync(join(counterDir, "component.hypen"), "Text('Counter')");

      const code = await generateComponentsCode(testDir, {
        patterns: ["folder"],
      });

      expect(code).toContain("Auto-generated component imports");
      expect(code).toContain("Counter");
      expect(code).toContain("CounterModule");
      expect(code).toContain('template: "Text');
    });

    test("generates stateless module for components without .ts", async () => {
      const footerDir = join(testDir, "Footer");
      mkdirSync(footerDir, { recursive: true });
      writeFileSync(join(footerDir, "component.hypen"), "Text('Footer')");

      const code = await generateComponentsCode(testDir, {
        patterns: ["folder"],
      });

      expect(code).toContain(
        'FooterModule = app.defineState({}, { name: "Footer" }).build()'
      );
    });

    test("generates import statements for modules", async () => {
      const headerDir = join(testDir, "Header");
      mkdirSync(headerDir, { recursive: true });
      writeFileSync(join(headerDir, "component.ts"), "export default {}");
      writeFileSync(join(headerDir, "component.hypen"), "Text('Header')");

      const code = await generateComponentsCode(testDir, {
        patterns: ["folder"],
      });

      expect(code).toContain("import HeaderModule from");
    });

    test("returns header comment for empty directory", async () => {
      const code = await generateComponentsCode(testDir, {
        patterns: ["folder"],
      });

      expect(code).toContain("Auto-generated");
    });
  });

  describe("DiscoveredComponent structure", () => {
    test("has correct structure with module", async () => {
      const dir = join(testDir, "Test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.ts"), "export default {}");
      writeFileSync(join(dir, "component.hypen"), "Text('Test')");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      const component = components[0];
      expect(component).toHaveProperty("name");
      expect(component).toHaveProperty("hypenPath");
      expect(component).toHaveProperty("modulePath");
      expect(component).toHaveProperty("template");
      expect(component).toHaveProperty("hasModule");

      expect(component.name).toBe("Test");
      expect(component.hypenPath).toContain("component.hypen");
      expect(component.modulePath).toContain("component.ts");
      expect(component.template).toBe("Text('Test')");
      expect(component.hasModule).toBe(true);
    });

    test("has correct structure without module", async () => {
      const dir = join(testDir, "Stateless");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.hypen"), "Text('Stateless')");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      const component = components[0];
      expect(component.name).toBe("Stateless");
      expect(component.modulePath).toBeNull();
      expect(component.hasModule).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("handles nested directory structures with recursive default", async () => {
      // Create deeply nested component — discovery is recursive by default
      const deepDir = join(testDir, "features", "auth", "Login");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "component.hypen"), "Text('Login')");

      // Recursive by default, should find the nested component
      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("Login");
    });

    test("handles nested directory structures with recursive disabled", async () => {
      // Create deeply nested component
      const deepDir = join(testDir, "features", "auth", "Login");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "component.hypen"), "Text('Login')");

      // Explicitly disable recursive — should find nothing
      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
        recursive: false,
      });

      expect(components).toHaveLength(0);
    });

    test("handles special characters in component names", async () => {
      const dir = join(testDir, "My-Component_v2");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.hypen"), "Text('Special')");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("My-Component_v2");
    });

    test("handles empty .hypen files", async () => {
      const dir = join(testDir, "Empty");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "component.hypen"), "");

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].template).toBe("");
    });

    test("handles large templates", async () => {
      const dir = join(testDir, "Large");
      mkdirSync(dir, { recursive: true });
      const largeTemplate = "Text('Hello')\n".repeat(10000);
      writeFileSync(join(dir, "component.hypen"), largeTemplate);

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      expect(components).toHaveLength(1);
      expect(components[0].template.length).toBeGreaterThan(100000);
    });

    test("handles templates with complex imports", async () => {
      const dir = join(testDir, "Complex");
      mkdirSync(dir, { recursive: true });
      const template = `import { Button, Card, Avatar } from "./ui"
import Header from "./Header"
import Footer from "./Footer"

Column {
  Header
  Text('Content')
  Footer
}`;
      writeFileSync(join(dir, "component.hypen"), template);

      const components = await discoverComponents(testDir, {
        patterns: ["folder"],
      });

      // Imports are now preserved — engine processes them via parse_document
      expect(components[0].template).toContain("import");
      expect(components[0].template).toContain("Column");
    });
  });

  describe("watchComponents", () => {
    test("does not throw when the directory does not exist", async () => {
      const missing = join(testDir, "no-such-dir", "components");

      const watcher = watchComponents(missing);
      // Give the initial (empty) scan a beat to settle before stopping.
      await new Promise((r) => setTimeout(r, 50));
      watcher.stop();
    });

    test("picks up components once a missing directory is created", async () => {
      const missing = join(testDir, "late", "components");
      const changes: DiscoveredComponent[][] = [];

      const watcher = watchComponents(missing, {
        patterns: ["sibling"],
        onChange: (components) => changes.push(components),
      });

      try {
        await new Promise((r) => setTimeout(r, 50));

        mkdirSync(missing, { recursive: true });
        writeFileSync(join(missing, "Late.ts"), "export default {}");
        writeFileSync(join(missing, "Late.hypen"), "Text('Late')");

        // Creation watch + debounce are async; poll rather than sleep a
        // fixed (flaky) amount.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (changes.some((c) => c.some((comp) => comp.name === "Late"))) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(
          changes.some((c) => c.some((comp) => comp.name === "Late"))
        ).toBe(true);
      } finally {
        watcher.stop();
      }
    });
  });
});
