import { describe, it, expect } from "bun:test";
import {
  scaffold,
  resolveOptions,
  toPascalCase,
  toBinding,
} from "../src/scaffold.ts";

describe("name helpers", () => {
  it("toPascalCase handles kebab/space/underscore", () => {
    expect(toPascalCase("my-dashboard")).toBe("MyDashboard");
    expect(toPascalCase("user profile")).toBe("UserProfile");
    expect(toPascalCase("App")).toBe("App");
  });

  it("toBinding produces a SCREAMING_SNAKE _DO binding", () => {
    expect(toBinding("App")).toBe("APP_DO");
    expect(toBinding("Dashboard")).toBe("DASHBOARD_DO");
    expect(toBinding("UserProfile")).toBe("USER_PROFILE_DO");
  });
});

describe("resolveOptions", () => {
  it("rejects invalid app names", () => {
    expect(() => resolveOptions({ appName: "My App" })).toThrow();
    expect(() => resolveOptions({ appName: "" })).toThrow();
    expect(() => resolveOptions({ appName: "UpperCase" })).toThrow();
  });

  it("derives DO class + binding from the module name", () => {
    const o = resolveOptions({ appName: "my-app", moduleName: "Dashboard" });
    expect(o.doClass).toBe("DashboardDO");
    expect(o.doBinding).toBe("DASHBOARD_DO");
    expect(o.moduleName).toBe("Dashboard");
  });

  it("defaults moduleName to App", () => {
    expect(resolveOptions({ appName: "x" }).moduleName).toBe("App");
  });
});

describe("scaffold output", () => {
  const files = scaffold({ appName: "my-app", moduleName: "Dashboard" });

  it("emits the expected file set", () => {
    expect([...files.keys()].sort()).toEqual(
      [
        ".gitignore",
        "README.md",
        "package.json",
        "src/components/Dashboard.ts",
        "src/do.ts",
        "src/engine.ts",
        "src/worker.ts",
        "tsconfig.json",
        "wrangler.jsonc",
      ].sort(),
    );
  });

  it("package.json is valid JSON with the right name + deps", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.name).toBe("my-app");
    expect(pkg.dependencies["@hypen-space/cf"]).toBeDefined();
    expect(pkg.dependencies["@hypen-space/core"]).toBeDefined();
    expect(pkg.dependencies["hypen-engine"]).toBeDefined();
    expect(pkg.scripts.dev).toBe("wrangler dev");
  });

  it("wrangler.jsonc wires the DO class + binding + CompiledWasm rule", () => {
    const w = files.get("wrangler.jsonc")!;
    expect(w).toContain('"class_name": "DashboardDO"');
    expect(w).toContain('"name": "DASHBOARD_DO"');
    expect(w).toContain('"type": "CompiledWasm"');
    expect(w).toContain('"new_sqlite_classes": ["DashboardDO"]');
    expect(w).toContain('"name": "my-app"');
  });

  it("do.ts subclasses HypenDurableObject and references the component + engine", () => {
    const code = files.get("src/do.ts")!;
    expect(code).toContain("extends HypenDurableObject");
    expect(code).toContain('moduleName: "Dashboard"');
    expect(code).toContain('from "./components/Dashboard"');
    expect(code).toContain("new CFEngine()");
  });

  it("worker.ts exports the DO class and routes via the binding", () => {
    const code = files.get("src/worker.ts")!;
    expect(code).toContain("export { DashboardDO }");
    expect(code).toContain("env.DASHBOARD_DO.idFromName");
  });

  it("engine.ts binds createCFEngine to the injected wasm", () => {
    const code = files.get("src/engine.ts")!;
    expect(code).toContain("createCFEngine(wasm");
    expect(code).toContain('from "hypen-engine/hypen_engine_bg.wasm"');
  });

  it("the component module defines state, an action, and an inline ui", () => {
    const code = files.get("src/components/Dashboard.ts")!;
    expect(code).toContain("defineState");
    expect(code).toContain('.onAction("increment"');
    expect(code).toContain("module Dashboard {");
  });

  it("defaults to an App module when none is given", () => {
    const f = scaffold({ appName: "plain" });
    expect(f.has("src/components/App.ts")).toBe(true);
    expect(f.get("src/do.ts")).toContain("class AppDO");
  });
});
