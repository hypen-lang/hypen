/**
 * Parse-error diagnostics for `hypen dev` / `hypen check`: the engine's
 * `… at position <byte offset>` messages become `file:line:col` code frames
 * pointing at the exact offending token, including after non-ASCII text.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  byteOffsetToLineCol,
  createHypenSourceValidator,
  formatHypenParseError,
  parseEngineErrorPositions,
} from "../src/dev-diagnostics";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hypen-diag-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEngineErrorPositions", () => {
  test("reads a message whose position is followed by nothing", () => {
    expect(parseEngineErrorPositions("expected ',' or ')', found '}' at position 41")).toEqual([
      { message: "expected ',' or ')', found '}'", byteOffset: 41 },
    ]);
  });

  test("splits a '; '-joined batch and strips the WASI prefix", () => {
    expect(
      parseEngineErrorPositions(
        "hypen_render_source: parse error: unclosed '{': expected a matching '}', found end of input at position 12; unexpected ';' at position 30",
      ),
    ).toEqual([
      { message: "unclosed '{': expected a matching '}', found end of input", byteOffset: 12 },
      { message: "unexpected ';'", byteOffset: 30 },
    ]);
  });

  test("ignores messages without positions", () => {
    expect(parseEngineErrorPositions("boom")).toEqual([]);
    expect(parseEngineErrorPositions("at position 3 is not the end, really")).toEqual([]);
  });
});

describe("formatHypenParseError", () => {
  test("points at the stray brace, not the enclosing block", () => {
    const source = "module Home {\n  Column {{{\n}";
    const lines = formatHypenParseError("Home/component.hypen", source, {
      type: "parseError",
      message: "expected component or '}', found '{' at position 24",
    });
    expect(lines).toEqual([
      "Home/component.hypen:2:11: parse error: expected component or '}', found '{'",
      "    1 | module Home {",
      "  > 2 |   Column {{{",
      "      |           ^",
      "    3 | }",
    ]);
  });

  test("byte offsets after multi-byte text land on the right column", () => {
    // "→" is 3 UTF-8 bytes: the second ',' is at byte 27 but column 15.
    const source = 'module A {\n  Text("Go →",, "x")\n}';
    expect(byteOffsetToLineCol(source, 27)).toEqual({ line: 2, col: 15 });
    const lines = formatHypenParseError("A.hypen", source, {
      message: "expected argument or ')', found ',' at position 27",
    });
    expect(lines[0]).toBe("A.hypen:2:15: parse error: expected argument or ')', found ','");
    expect(lines[2]).toBe("  > 2 |   Text(\"Go →\",, \"x\")");
    // The caret sits under the second ',' (14 characters of padding).
    expect(lines[3]).toBe(`      | ${" ".repeat(14)}^`);
  });

  test("tabs before the error are kept so the caret lines up", () => {
    const source = "Column {\n\tText(\"a\" ;)\n}";
    const lines = formatHypenParseError("t.hypen", source, { message: "expected ',' or ')', found ';' at position 20" });
    expect(lines[0]).toBe("t.hypen:2:12: parse error: expected ',' or ')', found ';'");
    expect(lines[3]).toBe("      | \t          ^");
  });

  test("every error of a batch gets its own frame", () => {
    const source = "Text(\"a\" ;)\nText(, 1)";
    const lines = formatHypenParseError("b.hypen", source, {
      message: "expected ',' or ')', found ';' at position 9; expected argument or ')', found ',' at position 17",
    });
    expect(lines.filter((l) => l.startsWith("b.hypen:"))).toEqual([
      "b.hypen:1:10: parse error: expected ',' or ')', found ';'",
      "b.hypen:2:6: parse error: expected argument or ')', found ','",
    ]);
  });
});

describe("validator with the real engine", () => {
  const cases: [string, string, string][] = [
    // [source, expected first line suffix (after "X/component.hypen:"), caret line]
    [
      "module X {\n  Column {{{\n}\n",
      "2:11: parse error: expected component or '}', found '{'",
      "  > 2 |   Column {{{",
    ],
    [
      'module X {\n  Column {\n    Text("hi"\n  }\n}\n',
      "4:3: parse error: expected ',' or ')', found '}' (the '(' at 3:9 is never closed)",
      "  > 4 |   }",
    ],
    [
      'module X {\n  Text("hello)\n}\n',
      "2:8: parse error: unclosed string literal: missing closing quote '\"'",
      '  > 2 |   Text("hello)',
    ],
    [
      'module X {\n  Text("a").padding(\n}\n',
      "3:1: parse error: expected argument or ')', found '}' (the '(' at 2:20 is never closed)",
      "  > 3 | }",
    ],
    [
      'module X {\n  Text("Hi @{state.name")\n}\n',
      "2:12: parse error: unclosed '@{' interpolation: expected '}' before the closing quote",
      '  > 2 |   Text("Hi @{state.name")',
    ],
    [
      'module X {\n  Text("é → ü") ;\n}\n',
      "2:17: parse error: expected '{', applicator (.name), component or '}', found ';'",
      '  > 2 |   Text("é → ü") ;',
    ],
  ];
  for (const [source, first, frameLine] of cases) {
    test(`reports ${JSON.stringify(first)}`, async () => {
      mkdirSync(join(dir, "X"), { recursive: true });
      writeFileSync(join(dir, "X/component.hypen"), source);
      const problems = await createHypenSourceValidator({ componentsDir: dir, projectRoot: dir })();
      expect(problems[0]).toBe(`X/component.hypen:${first}`);
      expect(problems).toContain(frameLine);
    });
  }
});
