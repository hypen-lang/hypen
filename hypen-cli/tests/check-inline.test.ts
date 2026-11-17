import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { A11yDiagnostic, TemplateRefsReport } from "@hypen-space/core";
import {
  byteToIndex,
  extractInlineTemplates,
  findInlineTemplateFiles,
  INTERPOLATION_BINDING,
  INTERPOLATION_IDENT,
  mapToTs,
  spanHasHole,
} from "../src/check-inline.js";
import { checkFileAccessibility, findCheckFiles, resolveCheckTargets } from "../src/check.js";
import {
  componentNameForFile,
  moduleFileFor,
  templateRefsForFile,
} from "../src/check-template.js";

/** 1-based line/col of the first occurrence of `needle` in `text`. */
function locate(text: string, needle: string): { line: number; col: number } {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle}`);
  const lines = text.slice(0, i).split("\n");
  return { line: lines.length, col: [...lines[lines.length - 1]!].length + 1 };
}

/** UTF-8 byte offset of the first occurrence of `needle` in `source`. */
function byteOf(source: string, needle: string): number {
  return Buffer.byteLength(source.slice(0, source.indexOf(needle)), "utf-8");
}

describe("extractInlineTemplates", () => {
  test("extracts plain and hypen-tagged .ui templates", () => {
    const ts = [
      'import { app, hypen } from "@hypen-space/core";',
      "export const A = app.defineState({}).ui(`Text(\"a\")`);",
      "export const B = app.defineState({}).ui(hypen`",
      '  Text("b")',
      "`);",
    ].join("\n");
    const t = extractInlineTemplates(ts);
    expect(t.map((x) => x.source)).toEqual(['Text("a")', '\n  Text("b")\n']);
    expect(t.every((x) => x.holes.length === 0)).toBe(true);
  });

  test("skips commented-out, concatenated and non-literal templates", () => {
    const ts = [
      "// x.ui(`Text(\"commented\")`)",
      " *   .ui(hypen`Text(\"doc\")`)",
      "a.ui(`Text(\"concat\")` + more);",
      "a.ui(template);",
    ].join("\n");
    expect(extractInlineTemplates(ts)).toEqual([]);
  });

  test("cooks escapes like JavaScript and maps every char back", () => {
    const ts = 'a.ui(`Text("\\\\"q\\\\"")\nText("\\u00e9")`)';
    const [t] = extractInlineTemplates(ts);
    expect(t!.source).toBe('Text("\\"q\\"")\nText("é")');
    // The second Text maps to line 2, col 1 of the .ts file.
    const idx = t!.source.indexOf('Text("é")');
    expect(t!.map[idx]).toBe(ts.indexOf('Text("\\u00e9")'));
  });

  test("interpolations in strings become bindings; elsewhere they become holes", () => {
    const ts =
      'a.ui(`Column { Text("${x}") Text("@{state.${k}}") ${PAGE} Button { Icon("x") }${EXTRA} }`)';
    const [t] = extractInlineTemplates(ts);
    expect(t!.source).toContain(`Text("${INTERPOLATION_BINDING}")`);
    expect(t!.source).toContain(`Text("@{state.${INTERPOLATION_IDENT}}")`);
    expect(t!.source).not.toContain("PAGE");
    expect(t!.holes.length).toBe(2);
    const button = t!.source.indexOf("Button");
    // The `${EXTRA}` hole sits inside the Button's expression span…
    expect(
      spanHasHole(t!, { start: button, end: t!.source.lastIndexOf("}") - 1 }),
    ).toBe(true);
    // …but not inside the first Text's.
    expect(spanHasHole(t!, { start: 9, end: 20 })).toBe(false);
  });

  test("an interpolation containing braces, strings and nested templates is skipped whole", () => {
    const ts = 'a.ui(`Text("${fn({ a: "}" }, `${"`"}`)}") Text("after")`)';
    const [t] = extractInlineTemplates(ts);
    expect(t!.source).toBe(`Text("${INTERPOLATION_BINDING}") Text("after")`);
  });

  test("an apostrophe inside a Hypen comment does not open a string", () => {
    const ts = "a.ui(`\n// don't\nText(${x})`)";
    const [t] = extractInlineTemplates(ts);
    expect(t!.holes.length).toBe(1);
  });
});

describe("position mapping", () => {
  const ts = [
    "const ACCENT = '#f00';",
    "export default app.ui(`",
    '  Column { Text("ünï ${ACCENT}") Button { Icon("x") } }',
    "`);",
  ].join("\n");
  const [t] = extractInlineTemplates(ts);

  test("byte spans map to .ts line/col (multibyte chars before the target)", () => {
    const at = mapToTs(ts, t!, { span: { start: byteOf(t!.source, "Button") } });
    expect(at).toEqual(locate(ts, "Button"));
  });

  test("line/col fall back when there is no span", () => {
    const at = mapToTs(ts, t!, { line: 2, col: 3 });
    expect(at).toEqual(locate(ts, "Column"));
  });

  test("byteToIndex counts UTF-8 bytes", () => {
    expect(byteToIndex("ü a", 3)).toBe(2);
  });
});

describe("checking a .ts file's inline templates", () => {
  const ts = [
    "export default app.ui(`",
    "  Column {",
    '    Button { Icon("trash") }',
    '    Button { Icon("x") }${EXTRA}',
    "  }",
    "`);",
  ].join("\n");

  test("a11y findings map to the .ts file; elements with holes are skipped", () => {
    const fake = (source: string): A11yDiagnostic[] =>
      ["Button { Icon(\"trash\") }", "Button { Icon(\"x\") }"].map((needle) => {
        const start = byteOf(source, needle);
        return {
          rule: "missing-accessible-name",
          elementType: "Button",
          message: "m",
          span: { start, end: start + 6 },
          exprSpan: { start, end: start + Buffer.byteLength(needle) + 1 },
          line: 99,
          col: 99,
        } as A11yDiagnostic;
      });
    const { diagnostics, skipped } = checkFileAccessibility(fake, "/p/W.ts", "W.ts", ts);
    expect(skipped).toBe(1);
    expect(diagnostics.length).toBe(1);
    expect({ line: diagnostics[0]!.line, col: diagnostics[0]!.col }).toEqual(
      locate(ts, 'Button { Icon("trash")'),
    );
  });

  test(".hypen files are passed through unchanged", () => {
    const d = { rule: "r", elementType: "E", message: "m", line: 1, col: 1 } as A11yDiagnostic;
    const out = checkFileAccessibility(() => [d], "/p/W.hypen", "W.hypen", "Text('x')");
    expect(out).toEqual({ diagnostics: [d], skipped: 0 });
  });

  test("a .ts file without an inline template cannot be checked", () => {
    expect(() => checkFileAccessibility(() => [], "/p/x.ts", "x.ts", "export {}")).toThrow(
      /no inline/,
    );
  });

  test("a parse error is reported at its .ts position with a frame", () => {
    const bad = "const x = 1;\nexport default app.ui(`\n  Text(\"a\" Text)\n`);";
    const throwing = (source: string): A11yDiagnostic[] => {
      throw { message: `expected ',' or ')' at position ${byteOf(source, "Text)")}` };
    };
    expect(() => checkFileAccessibility(throwing, "/p/x.ts", "x.ts", bad)).toThrow(
      /^x\.ts:3:12: parse error \(inline template\)/,
    );
  });

  test("template refs are merged and relocated", () => {
    const refs = (source: string): TemplateRefsReport => {
      const start = byteOf(source, "Icon");
      return {
        refs: [
          {
            kind: "component",
            name: "Icon",
            path: [],
            inLoop: false,
            fromExpression: false,
            elementType: "Icon",
            span: { start, end: start + 4 },
            line: 1,
            col: 1,
          } as any,
        ],
        diagnostics: [],
        declaredComponents: ["W"],
        importedComponents: [],
      };
    };
    const report = templateRefsForFile(refs, "/p/W.ts", "W.ts", ts);
    expect(report.declaredComponents).toEqual(["W"]);
    expect({ line: report.refs[0]!.line, col: report.refs[0]!.col }).toEqual(locate(ts, "Icon"));
  });
});

describe("discovery", () => {
  const dir = `/tmp/hypen-check-inline-test-${Date.now()}`;
  beforeEach(() => mkdirSync(join(dir, "sub"), { recursive: true }));
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("directory scans include .ts files with inline templates only", () => {
    writeFileSync(join(dir, "A.hypen"), "Text('a')");
    writeFileSync(join(dir, "A.ts"), "export default app.defineState({})");
    writeFileSync(join(dir, "sub/B.ts"), "export default app.ui(`Text('b')`)");
    writeFileSync(join(dir, "sub/B.test.ts"), "app.ui(`Text('t')`)");
    writeFileSync(join(dir, "sub/types.d.ts"), "app.ui(`Text('t')`)");
    expect(findInlineTemplateFiles(dir)).toEqual([join(dir, "sub/B.ts")]);
    expect(findCheckFiles(dir)).toEqual([join(dir, "A.hypen"), join(dir, "sub/B.ts")]);
    expect(resolveCheckTargets([dir], "/").files).toEqual([
      join(dir, "A.hypen"),
      join(dir, "sub/B.ts"),
    ]);
  });

  test("a single-file component is its own module", () => {
    writeFileSync(join(dir, "sub/B.ts"), "export default app.ui(`Text('b')`)");
    expect(componentNameForFile(join(dir, "sub/B.ts"))).toBe("B");
    expect(moduleFileFor(join(dir, "sub/B.ts"))).toBe(join(dir, "sub/B.ts"));
  });
});
