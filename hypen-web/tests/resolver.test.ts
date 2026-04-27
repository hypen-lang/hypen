import { describe, expect, test, mock, beforeEach } from "bun:test";
import {
  ComponentResolver,
  type ImportStatement,
  type ComponentDefinition,
} from "../packages/core/src/resolver";

describe("ComponentResolver", () => {
  describe("parseImports", () => {
    test("parses default import with local path", () => {
      const text = `import HomePage from "./pages/HomePage"`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports).toHaveLength(1);
      expect(imports[0]).toEqual({
        clause: { type: "default", name: "HomePage" },
        source: { type: "local", path: "./pages/HomePage" },
      });
    });

    test("parses named imports with local path", () => {
      const text = `import { Button, Card } from "./components/ui"`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports).toHaveLength(1);
      expect(imports[0]).toEqual({
        clause: { type: "named", names: ["Button", "Card"] },
        source: { type: "local", path: "./components/ui" },
      });
    });

    test("parses import with URL source", () => {
      const text = `import Button from "https://example.com/components/Button"`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports).toHaveLength(1);
      expect(imports[0]).toEqual({
        clause: { type: "default", name: "Button" },
        source: { type: "url", url: "https://example.com/components/Button" },
      });
    });

    test("parses multiple imports", () => {
      const text = `
        import HomePage from "./pages/HomePage"
        import { Button, Card } from "https://ui.example.com/components"
      `;
      const imports = ComponentResolver.parseImports(text);

      expect(imports).toHaveLength(2);
      expect(imports[0].clause).toEqual({ type: "default", name: "HomePage" });
      expect(imports[1].clause).toEqual({
        type: "named",
        names: ["Button", "Card"],
      });
    });

    test("handles named imports with whitespace", () => {
      const text = `import {  Button  ,  Card  ,  Badge  } from "./ui"`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports[0].clause).toEqual({
        type: "named",
        names: ["Button", "Card", "Badge"],
      });
    });

    test("handles empty named imports", () => {
      const text = `import {} from "./ui"`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports[0].clause).toEqual({ type: "named", names: [] });
    });

    test("returns empty array when no imports found", () => {
      const text = `Column { Text("Hello") }`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports).toHaveLength(0);
    });

    test("handles single quotes", () => {
      const text = `import Button from './components/Button'`;
      const imports = ComponentResolver.parseImports(text);

      expect(imports[0].source).toEqual({
        type: "local",
        path: "./components/Button",
      });
    });

    test("distinguishes http and https URLs", () => {
      const text1 = `import A from "http://example.com/a"`;
      const text2 = `import B from "https://example.com/b"`;

      const imports1 = ComponentResolver.parseImports(text1);
      const imports2 = ComponentResolver.parseImports(text2);

      expect(imports1[0].source).toEqual({
        type: "url",
        url: "http://example.com/a",
      });
      expect(imports2[0].source).toEqual({
        type: "url",
        url: "https://example.com/b",
      });
    });
  });

  describe("resolve", () => {
    test("resolves URL component with valid data", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      const result = await resolver.resolve(importStmt);

      expect(mockFetch).toHaveBeenCalledWith("https://example.com/test");
      expect(result).toEqual({
        TestComponent: {
          module: { name: "TestModule" },
          template: "Text('Test')",
        },
      });
    });

    test("caches resolved components", async () => {
      let fetchCount = 0;
      const mockFetch = mock(async () => {
        fetchCount++;
        return JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        });
      });

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await resolver.resolve(importStmt);
      await resolver.resolve(importStmt); // Second call should use cache

      expect(fetchCount).toBe(1);
    });

    test("bypasses cache when cache option is false", async () => {
      let fetchCount = 0;
      const mockFetch = mock(async () => {
        fetchCount++;
        return JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        });
      });

      const resolver = new ComponentResolver({
        customFetch: mockFetch,
        cache: false,
      });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await resolver.resolve(importStmt);
      await resolver.resolve(importStmt);

      expect(fetchCount).toBe(2);
    });

    test("clearCache removes cached components", async () => {
      let fetchCount = 0;
      const mockFetch = mock(async () => {
        fetchCount++;
        return JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        });
      });

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await resolver.resolve(importStmt);
      resolver.clearCache();
      await resolver.resolve(importStmt);

      expect(fetchCount).toBe(2);
    });

    test("throws error for invalid component format", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({ invalid: "format" })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow(
        "Invalid component format"
      );
    });

    test("throws error for missing module field", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({ template: "Text('Test')" })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow(
        "Invalid component format"
      );
    });

    test("throws error for missing template field", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({ module: { name: "Test" } })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow(
        "Invalid component format"
      );
    });

    test("throws error for invalid JSON", async () => {
      const mockFetch = mock(async () => "not valid json");

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow();
    });

    test("throws error for fetch failure", async () => {
      const mockFetch = mock(async () => {
        throw new Error("Network error");
      });

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow(
        "Failed to resolve component"
      );
    });

    test("throws error for local path resolution when file missing", async () => {
      const resolver = new ComponentResolver();
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "TestComponent" },
        source: { type: "local", path: "./components/Test" },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow();
    });

    test("handles named imports correctly", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "named", names: ["Button", "Card"] },
        source: { type: "url", url: "https://example.com/test" },
      };

      const result = await resolver.resolve(importStmt);

      expect(result).toEqual({
        Button: {
          module: { name: "TestModule" },
          template: "Text('Test')",
        },
        Card: {
          module: { name: "TestModule" },
          template: "Text('Test')",
        },
      });
    });

    test("handles empty named imports", async () => {
      const mockFetch = mock(async () =>
        JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        })
      );

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "named", names: [] },
        source: { type: "url", url: "https://example.com/test" },
      };

      const result = await resolver.resolve(importStmt);

      expect(result).toEqual({});
    });
  });

  // NOTE: These tests are skipped because they depend on external httpbin.org service
  // which may be unavailable or return unexpected status codes (e.g., 503)
  describe.skip("defaultFetch (external network tests)", () => {
    test("handles 404 errors", async () => {
      const resolver = new ComponentResolver();
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "NotFound" },
        source: {
          type: "url",
          url: "https://httpbin.org/status/404",
        },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow("HTTP 404");
    });

    test("handles 500 errors", async () => {
      const resolver = new ComponentResolver();
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "ServerError" },
        source: {
          type: "url",
          url: "https://httpbin.org/status/500",
        },
      };

      await expect(resolver.resolve(importStmt)).rejects.toThrow("HTTP 500");
    });
  });

  describe("options", () => {
    test("uses custom baseDir option", () => {
      const resolver = new ComponentResolver({ baseDir: "/custom/path" });
      expect(resolver).toBeDefined();
    });

    test("defaults baseDir to process.cwd()", () => {
      const resolver = new ComponentResolver();
      expect(resolver).toBeDefined();
    });

    test("cache defaults to true", async () => {
      let fetchCount = 0;
      const mockFetch = mock(async () => {
        fetchCount++;
        return JSON.stringify({
          module: { name: "TestModule" },
          template: "Text('Test')",
        });
      });

      const resolver = new ComponentResolver({ customFetch: mockFetch });
      const importStmt: ImportStatement = {
        clause: { type: "default", name: "Test" },
        source: { type: "url", url: "https://example.com/test" },
      };

      await resolver.resolve(importStmt);
      await resolver.resolve(importStmt);

      expect(fetchCount).toBe(1);
    });
  });
});
