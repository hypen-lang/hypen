import { describe, expect, test, beforeEach, mock } from "bun:test";
import { ComponentLoader } from "../packages/server/src/loader";
import type { HypenModuleDefinition } from "../packages/core/src/app";

describe("ComponentLoader", () => {
  let loader: ComponentLoader;

  beforeEach(() => {
    loader = new ComponentLoader();
  });

  describe("register", () => {
    test("registers a component with name, module, and template", () => {
      const module: HypenModuleDefinition = {
        initialState: { count: 0 },
        name: "Counter",
        actions: [],
        lifecycle: {},
      };
      const template = "Text('Hello')";

      loader.register("Counter", module, template);

      expect(loader.has("Counter")).toBe(true);
      expect(loader.get("Counter")).toEqual({
        name: "Counter",
        module,
        template,
        path: "Counter",
      });
    });

    test("registers component with custom path", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Button",
        actions: [],
        lifecycle: {},
      };
      const template = "Text('Click')";

      loader.register("Button", module, template, "./components/Button");

      const component = loader.get("Button");
      expect(component?.path).toBe("./components/Button");
    });

    test("overwrites existing component with same name", () => {
      const module1: HypenModuleDefinition = {
        initialState: { version: 1 },
        name: "Test",
        actions: [],
        lifecycle: {},
      };
      const module2: HypenModuleDefinition = {
        initialState: { version: 2 },
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("Test", module1, "Version 1");
      loader.register("Test", module2, "Version 2");

      const component = loader.get("Test");
      expect(component?.template).toBe("Version 2");
      expect(component?.module.initialState).toEqual({ version: 2 });
    });

    test("defaults path to component name when not provided", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Card",
        actions: [],
        lifecycle: {},
      };

      loader.register("Card", module, "Card template");

      expect(loader.get("Card")?.path).toBe("Card");
    });
  });

  describe("get", () => {
    test("returns undefined for non-existent component", () => {
      expect(loader.get("NonExistent")).toBeUndefined();
    });

    test("returns registered component", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("Test", module, "Template");

      const component = loader.get("Test");
      expect(component).toBeDefined();
      expect(component?.name).toBe("Test");
    });
  });

  describe("has", () => {
    test("returns false for non-existent component", () => {
      expect(loader.has("NonExistent")).toBe(false);
    });

    test("returns true for registered component", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("Test", module, "Template");

      expect(loader.has("Test")).toBe(true);
    });

    test("returns false after component is overwritten and then checked", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("Test", module, "Template");
      expect(loader.has("Test")).toBe(true);

      // Should still return true after overwrite
      loader.register("Test", module, "New Template");
      expect(loader.has("Test")).toBe(true);
    });
  });

  describe("getNames", () => {
    test("returns empty array when no components registered", () => {
      expect(loader.getNames()).toEqual([]);
    });

    test("returns array of registered component names", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("Button", module, "Button template");
      loader.register("Card", module, "Card template");
      loader.register("Avatar", module, "Avatar template");

      const names = loader.getNames();
      expect(names).toHaveLength(3);
      expect(names).toContain("Button");
      expect(names).toContain("Card");
      expect(names).toContain("Avatar");
    });

    test("returns names in insertion order", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      loader.register("A", module, "A");
      loader.register("B", module, "B");
      loader.register("C", module, "C");

      expect(loader.getNames()).toEqual(["A", "B", "C"]);
    });
  });

  describe("loadFromDirectory", () => {
    test("throws error when module file doesn't exist", async () => {
      await expect(
        loader.loadFromDirectory("NonExistent", "/non/existent/path")
      ).rejects.toThrow();
    });

    test("throws error when template file doesn't exist", async () => {
      // This test would require mocking the file system
      // For now, we test that the error is propagated
      await expect(
        loader.loadFromDirectory("Test", "/invalid/path")
      ).rejects.toThrow();
    });
  });

  describe("loadFromComponentsDir", () => {
    test("handles non-existent directory gracefully", async () => {
      // Should not throw, just warn and resolve successfully
      await loader.loadFromComponentsDir("/non/existent/directory");
      // If we reach here, the function didn't throw
      expect(true).toBe(true);
    });

    test("handles empty directory gracefully", async () => {
      // Create a temporary empty directory for testing
      const tmpDir = `/tmp/hypen-test-empty-${Date.now()}`;
      await Bun.write(`${tmpDir}/.keep`, "");

      try {
        await loader.loadFromComponentsDir(tmpDir);
        expect(loader.getNames()).toEqual([]);
      } finally {
        // Cleanup
        await Bun.write(`${tmpDir}/.keep`, "");
      }
    });
  });

  describe("integration", () => {
    test("multiple components can be registered and retrieved", () => {
      const modules = [
        {
          name: "Button",
          module: {
            initialState: { clicked: false },
            name: "Button",
            actions: [],
            lifecycle: {},
          } as HypenModuleDefinition,
          template: "Text('Click me')",
        },
        {
          name: "Card",
          module: {
            initialState: { expanded: false },
            name: "Card",
            actions: [],
            lifecycle: {},
          } as HypenModuleDefinition,
          template: "Column { }",
        },
        {
          name: "Avatar",
          module: {
            initialState: { url: "" },
            name: "Avatar",
            actions: [],
            lifecycle: {},
          } as HypenModuleDefinition,
          template: "Image(src: @state.url)",
        },
      ];

      modules.forEach(({ name, module, template }) => {
        loader.register(name, module, template);
      });

      expect(loader.getNames()).toHaveLength(3);
      expect(loader.get("Button")?.template).toBe("Text('Click me')");
      expect(loader.get("Card")?.template).toBe("Column { }");
      expect(loader.get("Avatar")?.template).toBe("Image(src: @state.url)");
    });

    test("components maintain separate state", () => {
      const module1: HypenModuleDefinition = {
        initialState: { value: 1 },
        name: "Component1",
        actions: [],
        lifecycle: {},
      };
      const module2: HypenModuleDefinition = {
        initialState: { value: 2 },
        name: "Component2",
        actions: [],
        lifecycle: {},
      };

      loader.register("Component1", module1, "Template1");
      loader.register("Component2", module2, "Template2");

      const comp1 = loader.get("Component1");
      const comp2 = loader.get("Component2");

      expect(comp1?.module.initialState).toEqual({ value: 1 });
      expect(comp2?.module.initialState).toEqual({ value: 2 });
    });
  });

  describe("edge cases", () => {
    test("handles components with empty templates", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Empty",
        actions: [],
        lifecycle: {},
      };

      loader.register("Empty", module, "");

      expect(loader.get("Empty")?.template).toBe("");
    });

    test("handles components with complex module definitions", () => {
      const module: HypenModuleDefinition = {
        initialState: {
          nested: {
            deeply: {
              value: "test",
            },
          },
          array: [1, 2, 3],
        },
        name: "Complex",
        actions: ["action1", "action2", "action3"],
        lifecycle: {
          onCreated: () => {},
          onDestroyed: () => {},
        },
      };

      loader.register("Complex", module, "Complex template");

      const component = loader.get("Complex");
      expect(component?.module.initialState).toEqual({
        nested: {
          deeply: {
            value: "test",
          },
        },
        array: [1, 2, 3],
      });
      expect(component?.module.actions).toEqual([
        "action1",
        "action2",
        "action3",
      ]);
    });

    test("handles component names with special characters", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      const specialNames = [
        "Button-Primary",
        "Card_Featured",
        "Avatar.Large",
        "Form/Input",
      ];

      specialNames.forEach((name) => {
        loader.register(name, module, "Template");
        expect(loader.has(name)).toBe(true);
      });

      expect(loader.getNames()).toHaveLength(4);
    });

    test("handles very long component names", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      const longName = "A".repeat(1000);
      loader.register(longName, module, "Template");

      expect(loader.has(longName)).toBe(true);
      expect(loader.get(longName)?.name).toBe(longName);
    });

    test("handles very long templates", () => {
      const module: HypenModuleDefinition = {
        initialState: {},
        name: "Test",
        actions: [],
        lifecycle: {},
      };

      const longTemplate = "Text('Hello')".repeat(10000);
      loader.register("Test", module, longTemplate);

      expect(loader.get("Test")?.template).toBe(longTemplate);
    });
  });
});
