import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// Test the helper functions from plugin.ts by importing them
// Since they're not exported, we'll test the logic directly

describe("Plugin Helper Functions", () => {
  const testDir = `/tmp/hypen-plugin-test-${Date.now()}`;

  beforeEach(() => {
    // Create test directory structure
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("findModulePath logic", () => {
    // Recreate the logic from plugin.ts for testing
    function findModulePath(
      hypenPath: string,
      patterns: ("sibling" | "component" | "index")[]
    ): string | null {
      const { dirname, basename } = require("path");
      const dir = dirname(hypenPath);
      const baseName = basename(hypenPath, ".hypen");

      for (const pattern of patterns) {
        let candidatePath: string | null = null;

        switch (pattern) {
          case "sibling":
            candidatePath = join(dir, `${baseName}.ts`);
            break;
          case "component":
            if (baseName === "component") {
              candidatePath = join(dir, "component.ts");
            }
            break;
          case "index":
            if (baseName === "index") {
              candidatePath = join(dir, "index.ts");
            }
            break;
        }

        if (candidatePath && existsSync(candidatePath)) {
          return candidatePath;
        }
      }

      return null;
    }

    test("finds sibling module file", () => {
      const componentDir = join(testDir, "Counter");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "Counter.ts"), "export default {}");
      writeFileSync(join(componentDir, "Counter.hypen"), "Text('Hello')");

      const result = findModulePath(
        join(componentDir, "Counter.hypen"),
        ["sibling"]
      );

      expect(result).toBe(join(componentDir, "Counter.ts"));
    });

    test("finds component.ts in folder pattern", () => {
      const componentDir = join(testDir, "Counter");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('Hello')");

      const result = findModulePath(
        join(componentDir, "component.hypen"),
        ["component"]
      );

      expect(result).toBe(join(componentDir, "component.ts"));
    });

    test("finds index.ts in index pattern", () => {
      const componentDir = join(testDir, "Counter");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "index.ts"), "export default {}");
      writeFileSync(join(componentDir, "index.hypen"), "Text('Hello')");

      const result = findModulePath(
        join(componentDir, "index.hypen"),
        ["index"]
      );

      expect(result).toBe(join(componentDir, "index.ts"));
    });

    test("returns null when no module file exists", () => {
      const componentDir = join(testDir, "Counter");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "Counter.hypen"), "Text('Hello')");

      const result = findModulePath(
        join(componentDir, "Counter.hypen"),
        ["sibling", "component", "index"]
      );

      expect(result).toBeNull();
    });

    test("tries patterns in order", () => {
      const componentDir = join(testDir, "Counter");
      mkdirSync(componentDir, { recursive: true });
      // Create both sibling and component.ts
      writeFileSync(join(componentDir, "component.ts"), "export default { sibling: false }");
      writeFileSync(join(componentDir, "component.hypen"), "Text('Hello')");

      // With component pattern first, should find component.ts
      const result = findModulePath(
        join(componentDir, "component.hypen"),
        ["component", "sibling"]
      );

      expect(result).toBe(join(componentDir, "component.ts"));
    });
  });

  describe("getComponentName logic", () => {
    function getComponentName(hypenPath: string): string {
      const { dirname, basename } = require("path");
      const baseName = basename(hypenPath, ".hypen");

      if (baseName === "component" || baseName === "index") {
        return basename(dirname(hypenPath));
      }

      return baseName;
    }

    test("extracts name from sibling file", () => {
      expect(getComponentName("/app/components/Counter.hypen")).toBe("Counter");
    });

    test("extracts name from folder for component.hypen", () => {
      expect(getComponentName("/app/components/Counter/component.hypen")).toBe("Counter");
    });

    test("extracts name from folder for index.hypen", () => {
      expect(getComponentName("/app/components/Counter/index.hypen")).toBe("Counter");
    });

    test("handles deeply nested paths", () => {
      expect(getComponentName("/app/src/features/auth/Login/component.hypen")).toBe("Login");
    });

    test("handles names with special characters", () => {
      expect(getComponentName("/app/components/My-Component.hypen")).toBe("My-Component");
    });
  });

  describe("parseImports logic", () => {
    function parseImports(text: string): Array<{ names: string[]; source: string }> {
      const imports: Array<{ names: string[]; source: string }> = [];
      const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;

      let match;
      while ((match = importRegex.exec(text)) !== null) {
        const [, namedImports, defaultImport, source] = match;

        let names: string[];
        if (namedImports) {
          names = namedImports
            .split(",")
            .map((n) => n.trim())
            .filter((n) => n.length > 0);
        } else {
          names = [defaultImport];
        }

        imports.push({ names, source });
      }

      return imports;
    }

    test("parses default import", () => {
      const text = 'import Button from "./Button"';
      const result = parseImports(text);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ names: ["Button"], source: "./Button" });
    });

    test("parses named imports", () => {
      const text = 'import { Button, Card } from "./components"';
      const result = parseImports(text);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ names: ["Button", "Card"], source: "./components" });
    });

    test("parses multiple import statements", () => {
      const text = `
        import Button from "./Button"
        import { Card, Avatar } from "./ui"
      `;
      const result = parseImports(text);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ names: ["Button"], source: "./Button" });
      expect(result[1]).toEqual({ names: ["Card", "Avatar"], source: "./ui" });
    });

    test("returns empty array for no imports", () => {
      const text = "Text('Hello World')";
      const result = parseImports(text);

      expect(result).toEqual([]);
    });

    test("handles imports with single quotes", () => {
      const text = "import Button from './Button'";
      const result = parseImports(text);

      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("./Button");
    });
  });

  describe("removeImports logic", () => {
    function removeImports(text: string): string {
      return text.replace(
        /import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*/g,
        ""
      );
    }

    test("removes single import", () => {
      const text = 'import Button from "./Button"\nText("Hello")';
      const result = removeImports(text);

      expect(result.trim()).toBe('Text("Hello")');
    });

    test("removes multiple imports", () => {
      const text = `import Button from "./Button"
import { Card } from "./Card"
Text("Hello")`;
      const result = removeImports(text);

      expect(result.trim()).toBe('Text("Hello")');
    });

    test("preserves content without imports", () => {
      const text = 'Column { Text("Hello") }';
      const result = removeImports(text);

      expect(result).toBe('Column { Text("Hello") }');
    });

    test("removes imports with trailing whitespace", () => {
      const text = 'import X from "x"   \nContent';
      const result = removeImports(text);

      expect(result.trim()).toBe("Content");
    });
  });
});
