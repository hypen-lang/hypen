import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { TemplateRef, TemplateRefsReport } from "@hypen-space/core";
import {
  classifyStatePath,
  combineOutcomes,
  componentNameForFile,
  componentsInLoopContext,
  detectModuleLanguage,
  detectTemplateRuleDrift,
  evaluateTemplate,
  EXPECTED_CHECK_RULES,
  findSingleFileComponentNames,
  formatSkipNotes,
  formatTemplateReport,
  moduleFactsFromDefinition,
  moduleFileFor,
  type ModuleFacts,
  type TemplateCheckInput,
} from "../src/check-template.js";
import { COULD_NOT_CHECK } from "../src/check.js";
import { EXPECTED_TEMPLATE_CHECK_RULES } from "../../hypen-web/packages/core/src/template-refs.js";

function ref(partial: Partial<TemplateRef> & Pick<TemplateRef, "kind" | "name">): TemplateRef {
  return {
    path: [],
    inLoop: false,
    fromExpression: false,
    elementType: "Text",
    line: 1,
    col: 1,
    ...partial,
  };
}

function stateRef(path: string, extra: Partial<TemplateRef> = {}): TemplateRef {
  return ref({ kind: "state", name: path, path: path.split("."), ...extra });
}

function report(refs: TemplateRef[], extra: Partial<TemplateRefsReport> = {}): TemplateRefsReport {
  return { refs, diagnostics: [], declaredComponents: [], importedComponents: [], ...extra };
}

function facts(initialState: unknown, actions: string[] = []): ModuleFacts {
  return { initialState, actions: new Set(actions) };
}

function run(input: Partial<TemplateCheckInput> & { report: TemplateRefsReport }) {
  return evaluateTemplate({
    component: "App",
    module: { kind: "loaded", facts: facts({}) },
    knownComponents: new Set(),
    inLoopContext: new Set(),
    usedComponents: new Set(),
    ...input,
  });
}

describe("classifyStatePath", () => {
  const state = {
    count: 0,
    user: { name: "a", address: { city: "x" } },
    items: [{ id: 1 }],
    selected: null,
    byId: {},
  };

  test("resolved paths are ok", () => {
    expect(classifyStatePath(state, ["count"])).toBe("ok");
    expect(classifyStatePath(state, ["user", "address", "city"])).toBe("ok");
  });

  test("an absent root key is unknown", () => {
    expect(classifyStatePath(state, ["cuont"])).toBe("unknown-root");
  });

  test("an absent key under a plain non-empty object is unknown at that segment", () => {
    expect(classifyStatePath(state, ["user", "nmae"])).toEqual({ unknownAt: 1 });
    expect(classifyStatePath(state, ["user", "address", "zip"])).toEqual({ unknownAt: 2 });
  });

  test("never judges through null, arrays, primitives or empty objects", () => {
    expect(classifyStatePath(state, ["selected", "name"])).toBe("unknowable");
    expect(classifyStatePath(state, ["items", "0", "id"])).toBe("unknowable");
    expect(classifyStatePath(state, ["user", "name", "toUpperCase"])).toBe("unknowable");
    expect(classifyStatePath(state, ["byId", "abc"])).toBe("unknowable");
  });

  test("a non-object initial state is unknowable", () => {
    expect(classifyStatePath(null, ["x"])).toBe("unknowable");
    expect(classifyStatePath([1], ["x"])).toBe("unknowable");
  });
});

describe("evaluateTemplate: unknown-state-path", () => {
  test("flags a root key missing from every module", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({ count: 0 }) },
      report: report([stateRef("count"), stateRef("cuont", { line: 3, col: 9 })]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "unknown-state-path", line: 3, col: 9 });
    expect(findings[0].message).toContain('"cuont"');
  });

  test("a root key another module provides is not flagged (merged-state hosts)", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({}) },
      otherModules: [facts({ cart: [] })],
      report: report([stateRef("cart")]),
    });
    expect(findings).toEqual([]);
  });

  test("roots are not judged when another module failed to load", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({ a: 1 }) },
      otherModulesComplete: false,
      report: report([stateRef("b")]),
    });
    expect(findings).toEqual([]);
  });

  test("flags a deep key only when every owning module lacks it", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({ user: { name: "a" } }) },
      report: report([stateRef("user.nmae"), stateRef("user.name.length")]),
    });
    expect(findings.map((f) => f.rule)).toEqual(["unknown-state-path"]);
    expect(findings[0].message).toContain('"nmae"');
  });

  test("skips reserved roots, module-name prefixes and other modules' scopes", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({ a: 1 }) },
      moduleNames: new Set(["search"]),
      report: report([
        stateRef("__dnd.board.x"),
        stateRef("search.query"),
        stateRef("missing", { moduleScope: "other" }),
      ]),
    });
    expect(findings).toEqual([]);
  });

  test("a module-less template gets no state verdicts", () => {
    const { findings } = run({ module: { kind: "none" }, report: report([stateRef("anything")]) });
    expect(findings).toEqual([]);
  });
});

describe("evaluateTemplate: unknown-action", () => {
  const action = (name: string, extra: Partial<TemplateRef> = {}) =>
    ref({ kind: "action", name, elementType: "Button", reserved: false, ...extra });

  test("flags an action with no handler anywhere", () => {
    const { findings } = run({
      module: { kind: "loaded", facts: facts({}, ["save"]) },
      report: report([action("save"), action("sav")]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "unknown-action", elementType: "Button" });
    expect(findings[0].message).toContain('.onAction("sav"');
  });

  test("ignores reserved namespaces and data-source methods", () => {
    const { findings } = run({
      report: report([
        action("router.push", { reserved: true }),
        action("__hypen_bind", { reserved: true }),
        action("spacetime.sendMessage"),
      ]),
    });
    expect(findings).toEqual([]);
  });

  test("an action another module handles is not flagged", () => {
    const { findings } = run({
      otherModules: [facts({}, ["checkout"])],
      report: report([action("checkout")]),
    });
    expect(findings).toEqual([]);
  });
});

describe("evaluateTemplate: unknown-component", () => {
  const comp = (name: string, builtin = false) => ref({ kind: "component", name, builtin, elementType: name });

  test("flags names that are neither built in nor known", () => {
    const { findings } = run({
      knownComponents: new Set(["PostCard"]),
      report: report([comp("Text", true), comp("PostCard"), comp("postcard"), comp("Txt")]),
    });
    expect(findings.map((f) => f.elementType)).toEqual(["Txt"]);
  });

  test("declared and imported names count as known", () => {
    const { findings } = run({
      report: report([comp("Local"), comp("Shared")], {
        declaredComponents: ["Local"],
        importedComponents: ["Shared"],
      }),
    });
    expect(findings).toEqual([]);
  });

  test("runs even when the module could not be loaded", () => {
    const { findings } = run({
      module: { kind: "failed", reason: "boom" },
      report: report([comp("Nope")]),
    });
    expect(findings.map((f) => f.rule)).toEqual(["unknown-component"]);
  });
});

describe("evaluateTemplate: item-outside-loop", () => {
  const item = ref({ kind: "item", name: "item.title", root: "item", path: ["title"], inScope: false });

  test("silent when the component is rendered inside a loop somewhere", () => {
    const { findings } = run({
      component: "Post",
      usedComponents: new Set(["Post"]),
      inLoopContext: new Set(["Post"]),
      report: report([item]),
    });
    expect(findings).toEqual([]);
  });

  test("flags when every usage is outside a loop", () => {
    const { findings } = run({
      component: "Post",
      usedComponents: new Set(["Post"]),
      report: report([item]),
    });
    expect(findings.map((f) => f.rule)).toEqual(["item-outside-loop"]);
  });

  test("flags in the entry component", () => {
    const { findings } = run({ component: "App", entry: "App", report: report([item]) });
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("entry component");
  });

  test("silent without evidence (unused, not the entry) and for in-scope refs", () => {
    expect(run({ component: "Orphan", report: report([item]) }).findings).toEqual([]);
    const inScope = { ...item, inScope: true, inLoop: true };
    expect(run({ component: "App", entry: "App", report: report([inScope]) }).findings).toEqual([]);
  });
});

describe("evaluateTemplate: suppression", () => {
  test("inline directives and config ignoreRules are counted, not reported", () => {
    const result = run({
      module: { kind: "loaded", facts: facts({}) },
      ignoreRules: ["unknown-component"],
      report: report(
        [
          stateRef("a", { ignoreAll: true }),
          stateRef("b", { ignoreRules: ["unknown-state-path"] }),
          stateRef("c", { ignoreRules: ["unknown-action"] }),
          ref({ kind: "component", name: "Nope", builtin: false }),
        ],
        {
          diagnostics: [
            { rule: "unknown-ignore-rule", elementType: "hypen-check-ignore", message: "x", suppressed: true },
            { rule: "unknown-ignore-rule", elementType: "hypen-check-ignore", message: "typo", line: 2, col: 4 },
          ],
        },
      ),
    });
    expect(result.suppressedCount).toBe(4);
    expect(result.findings.map((f) => f.rule).sort()).toEqual(["unknown-ignore-rule", "unknown-state-path"]);
  });
});

describe("componentsInLoopContext", () => {
  test("loop context flows transitively through instantiation", () => {
    const ctx = componentsInLoopContext([
      { owner: "Feed", name: "Post", inLoop: true },
      { owner: "Post", name: "Avatar", inLoop: false },
      { owner: "App", name: "Header", inLoop: false },
    ]);
    expect([...ctx].sort()).toEqual(["Avatar", "Post"]);
  });
});

describe("moduleFactsFromDefinition", () => {
  test("reads initial state and onAction handler names", () => {
    const f = moduleFactsFromDefinition({
      initialState: { a: 1 },
      actions: ["x"],
      handlers: { onAction: new Map([["y", () => {}]]) },
    });
    expect(f?.initialState).toEqual({ a: 1 });
    expect([...(f?.actions ?? [])].sort()).toEqual(["x", "y"]);
  });

  test("builds an unbuilt builder", () => {
    const def = { initialState: { b: 2 }, actions: [], handlers: { onAction: new Map() } };
    expect(moduleFactsFromDefinition({ build: () => def })?.initialState).toEqual({ b: 2 });
  });

  test("anything else is not a module", () => {
    expect(moduleFactsFromDefinition(undefined)).toBeNull();
    expect(moduleFactsFromDefinition({ foo: 1 })).toBeNull();
  });
});

describe("rule ids", () => {
  test("the CLI and core lists mirror the engine's CheckRule ids", () => {
    // Pinned in Rust by ir/refs.rs's every_rule_is_listed_with_its_published_id.
    const ids = [
      "unknown-state-path",
      "unknown-action",
      "unknown-component",
      "item-outside-loop",
      "unknown-ignore-rule",
    ];
    expect([...EXPECTED_CHECK_RULES]).toEqual(ids);
    expect([...EXPECTED_TEMPLATE_CHECK_RULES]).toEqual(ids);
  });
});

describe("drift, outcomes and reporting", () => {
  test("detectTemplateRuleDrift", () => {
    expect(detectTemplateRuleDrift(null)).toEqual([...EXPECTED_CHECK_RULES]);
    expect(detectTemplateRuleDrift({ templateCheckRules: () => [...EXPECTED_CHECK_RULES] })).toEqual([]);
    expect(detectTemplateRuleDrift({ templateCheckRules: () => ["unknown-action"] })).toContain(
      "item-outside-loop",
    );
  });

  test("combineOutcomes: findings win, then couldn't-check, then clean", () => {
    expect(combineOutcomes(2, 3)).toBe(5);
    expect(combineOutcomes(COULD_NOT_CHECK, 1)).toBe(1);
    expect(combineOutcomes(0, COULD_NOT_CHECK)).toBe(COULD_NOT_CHECK);
    expect(combineOutcomes(0, 0)).toBe(0);
  });

  test("formatTemplateReport", () => {
    const { lines, count } = formatTemplateReport(
      [
        { file: "A.hypen", finding: { rule: "unknown-action", elementType: "Button", message: "m", line: 2, col: 5 } },
        { file: "A.hypen", finding: { rule: "unknown-component", elementType: "X", message: "n" } },
      ],
      1,
    );
    expect(count).toBe(2);
    expect(lines).toEqual([
      "A.hypen:2:5: check[unknown-action] Button — m",
      "A.hypen: check[unknown-component] X — n",
      "Found 2 template issues across 1 file.",
      "1 finding suppressed.",
    ]);
    expect(formatTemplateReport([]).lines).toEqual(["No template issues found."]);
  });

  test("formatSkipNotes never lets skipped cross-checks pass silently", () => {
    const notes = formatSkipNotes([
      { file: "a.hypen", status: { kind: "none" } },
      { file: "b.hypen", status: { kind: "non-ts", language: "Go" } },
      { file: "c.hypen", status: { kind: "failed", reason: "module failed to load (x)" } },
    ]);
    expect(notes.join("\n")).toContain("not TypeScript (Go)");
    expect(notes.join("\n")).toContain("no module file of its own");
    expect(notes.join("\n")).toContain("c.hypen: module failed to load (x)");
  });
});

describe("project layout", () => {
  const dir = `/tmp/hypen-check-template-test-${Date.now()}`;
  beforeEach(() => mkdirSync(dir, { recursive: true }));
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("component names and module pairing follow discovery conventions", () => {
    mkdirSync(join(dir, "Counter"));
    writeFileSync(join(dir, "Counter/component.hypen"), "Text('x')");
    writeFileSync(join(dir, "Counter/component.ts"), "export default {}");
    writeFileSync(join(dir, "Card.hypen"), "Text('x')");
    expect(componentNameForFile(join(dir, "Counter/component.hypen"))).toBe("Counter");
    expect(componentNameForFile(join(dir, "Card.hypen"))).toBe("Card");
    expect(moduleFileFor(join(dir, "Counter/component.hypen"))).toBe(join(dir, "Counter/component.ts"));
    expect(moduleFileFor(join(dir, "Card.hypen"))).toBeNull();
  });

  test("single-file components are found without importing them", () => {
    writeFileSync(join(dir, "Inline.ts"), "export default app.defineState({}).ui(hypen`Text('x')`)");
    writeFileSync(join(dir, "helper.ts"), "export const x = 1");
    expect(findSingleFileComponentNames(dir)).toEqual(["Inline"]);
  });

  test("non-TypeScript module ecosystems are detected", () => {
    expect(detectModuleLanguage(dir)).toBeNull();
    writeFileSync(join(dir, "go.mod"), "module x");
    expect(detectModuleLanguage(dir)).toBe("Go");
  });
});
