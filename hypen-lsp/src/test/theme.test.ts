/**
 * Tests for `@theme.*` diagnostics (theme.ts): verdicts per scheme, alias
 * leniency, expressions, comments, suppression, and theme-file discovery.
 *
 * Run with: npx tsx src/test/theme.test.ts
 */

import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findTheme, themeDiagnostics, themeFromJson, UNKNOWN_THEME_TOKEN_CODE } from "../theme";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

const theme = themeFromJson({
  tokens: { color: { brand: "#06f", primary: "{color.brand}", surface: "#fff" }, space: { md: 16 }, all: "{color}" },
  schemes: { dark: { color: { surface: "#111" }, glow: "#fff" } },
})!;

console.log("themeDiagnostics tests:");

test("defined tokens and groups are quiet", () => {
  const text = 'Text("x").color(@theme.color.primary).padding(@theme.space.md)\nText("@{theme.color.surface}")';
  assert.deepEqual(themeDiagnostics(text, theme), []);
});

test("an undefined token is squiggled over the whole reference", () => {
  const text = 'Column {\n    Text("x").color(@theme.color.primry)\n}';
  const diags = themeDiagnostics(text, theme);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, UNKNOWN_THEME_TOKEN_CODE);
  assert.equal(diags[0].source, "hypen-check");
  assert.deepEqual(diags[0].range, { start: { line: 1, character: 20 }, end: { line: 1, character: 39 } });
  assert.match(diags[0].message, /theme\.color\.primry is not defined in the theme file/);
});

test("a token only some schemes define names the schemes that lack it", () => {
  const diags = themeDiagnostics("Text(@theme.glow)", theme);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /not defined for light/);
});

test("references inside expressions are checked; other identifiers are not", () => {
  const text = `Text("@{appearance.scheme == 'dark' ? theme.color.nope : state.theme.color.nope}")`;
  const diags = themeDiagnostics(text, theme);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /theme\.color\.nope/);
});

test("anything at or below an alias is accepted", () => {
  assert.deepEqual(themeDiagnostics("Text(@theme.all.brand) Text(@theme.color.primary.x)", theme), []);
});

test("comments are skipped and hypen-check-ignore is honoured", () => {
  assert.deepEqual(themeDiagnostics("// Text(@theme.nope)", theme), []);
  assert.deepEqual(themeDiagnostics("Text(@theme.nope) // hypen-check-ignore", theme), []);
  assert.deepEqual(
    themeDiagnostics("// hypen-check-ignore unknown-theme-token\nText(@theme.nope)", theme),
    [],
  );
  assert.equal(themeDiagnostics("Text(@theme.nope) // hypen-check-ignore unknown-action", theme).length, 1);
});

test("no theme means no verdicts", () => {
  assert.deepEqual(themeDiagnostics("Text(@theme.nope)", null), []);
  assert.equal(themeFromJson([]), null);
  assert.equal(themeFromJson({ tokens: 3 }), null);
});

console.log("findTheme tests:");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypen-lsp-theme-"));
try {
  const doc = path.join(root, "src/components/App/component.hypen");
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, "");

  test("no theme file anywhere up to the project root", () => {
    fs.writeFileSync(path.join(root, "hypen.json"), "{}");
    assert.equal(findTheme(doc), null);
  });

  test("theme.json beside hypen.json", () => {
    fs.writeFileSync(path.join(root, "theme.json"), JSON.stringify({ tokens: { a: 1 } }));
    assert.equal(themeDiagnostics("Text(@theme.a) Text(@theme.b)", findTheme(doc)).length, 1);
  });

  test("hypen.json \"theme\" wins, and edits are picked up", () => {
    fs.mkdirSync(path.join(root, "design"));
    const file = path.join(root, "design/tokens.json");
    fs.writeFileSync(file, JSON.stringify({ tokens: { b: 1 } }));
    fs.writeFileSync(path.join(root, "hypen.json"), JSON.stringify({ theme: "./design/tokens.json" }));
    assert.match(themeDiagnostics("Text(@theme.a) Text(@theme.b)", findTheme(doc))[0].message, /theme\.a /);
    fs.writeFileSync(file, JSON.stringify({ tokens: { a: 1, b: 1 } }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(themeDiagnostics("Text(@theme.a) Text(@theme.b)", findTheme(doc)), []);
  });

  test("an unparseable theme file gives no verdicts", () => {
    const file = path.join(root, "design/tokens.json");
    fs.writeFileSync(file, "{ nope");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.equal(findTheme(doc), null);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
