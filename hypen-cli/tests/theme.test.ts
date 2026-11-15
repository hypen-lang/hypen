/**
 * The project theme file: loading, resolution (pinned to the cross-SDK
 * fixture), `@theme` verdicts, and `hypen theme export`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  classifyThemeToken,
  exportAndroid,
  exportCss,
  exportIos,
  loadThemeFile,
  nearestToken,
  parseHexColor,
  parseThemeFile,
  resolveAllSchemes,
  resolveScheme,
  unreferenceableKeys,
  type ThemeFile,
} from "../src/theme.js";
import fixture from "../../engine-compatibility-tests/fixtures/theme/resolve.json";

const theme: ThemeFile = {
  tokens: {
    color: { brand: "#0066ff", primary: "{color.brand}", surface: "#fff", overlay: "rgba(0,0,0,0.5)" },
    space: { md: 16 },
    font: { body: "Inter" },
    dense: false,
  },
  schemes: {
    dark: { color: { brand: "#66a3ff", surface: "#11111180" }, glow: { color: "#ffffff" } },
    sepia: { color: { surface: "#f4ecd8" } },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hypen-theme-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolution matches the cross-SDK fixture", () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      const scheme = c.preference === "system" ? c.system : c.preference;
      const resolved = resolveScheme({ tokens: c.tokens as any, schemes: c.schemes as any }, scheme);
      expect(resolved.tokens).toEqual(c.expected.tokens as any);
      expect(resolved.problems).toHaveLength(c.expected.problems);
    });
  }
});

describe("loadThemeFile", () => {
  test("no file is not a failure; theme.json is found by default", () => {
    expect(loadThemeFile(dir)).toEqual({ kind: "none" });
    writeFileSync(join(dir, "theme.json"), JSON.stringify(theme));
    const status = loadThemeFile(dir);
    expect(status.kind).toBe("loaded");
    expect(status.kind === "loaded" && status.file).toBe("theme.json");
  });

  test("a configured path that is missing, or bad content, fails with a reason", () => {
    expect(loadThemeFile(dir, "./design/tokens.json")).toMatchObject({ kind: "failed" });
    writeFileSync(join(dir, "theme.json"), "{ nope");
    expect(loadThemeFile(dir)).toMatchObject({ kind: "failed", file: "theme.json" });
  });

  test("parseThemeFile rejects wrong shapes", () => {
    expect(parseThemeFile([])).toContain("JSON object");
    expect(parseThemeFile({ tokens: { a: null } })).toContain("tokens.a");
    expect(parseThemeFile({ tokens: {}, schemes: { dark: { a: [1] } } })).toContain("schemes.dark.a");
    expect(parseThemeFile({ schemes: { system: {} } })).toContain("reserved");
    expect(parseThemeFile({})).toEqual({ tokens: {}, schemes: {} });
  });
});

describe("@theme verdicts", () => {
  const schemes = resolveAllSchemes(theme);

  test("every scheme an app can be in is resolved", () => {
    expect(schemes.map((s) => s.scheme)).toEqual(["light", "dark", "sepia"]);
  });

  test("defined everywhere, nowhere, or only in some schemes", () => {
    expect(classifyThemeToken(schemes, ["color", "primary"])).toBe("ok");
    expect(classifyThemeToken(schemes, ["color"])).toBe("ok");
    expect(classifyThemeToken(schemes, ["color", "nope"])).toEqual({
      missingIn: ["light", "dark", "sepia"],
      definedIn: [],
    });
    expect(classifyThemeToken(schemes, ["glow", "color"])).toEqual({
      missingIn: ["light", "sepia"],
      definedIn: ["dark"],
    });
  });

  test("nearestToken suggests close spellings only", () => {
    expect(nearestToken(schemes, ["color", "primry"])).toBe("color.primary");
    expect(nearestToken(schemes, ["totally", "different"])).toBeNull();
  });

  test("unreferenceableKeys", () => {
    expect(unreferenceableKeys({ tokens: { "2-xl": 1, ok: { "a.b": 2 } }, schemes: { dark: { "x y": 1 } } })).toEqual([
      "2-xl",
      "ok.a.b",
      "x y",
    ]);
  });
});

describe("export", () => {
  test("parseHexColor", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseHexColor("#11111180")).toEqual({ r: 17, g: 17, b: 17, a: 128 });
    expect(parseHexColor("rgb(0,0,0)")).toBeNull();
    expect(parseHexColor(16)).toBeNull();
  });

  test("css: :root is light, schemes override only what differs", () => {
    const css = exportCss(theme).files["theme.css"]!;
    expect(css).toContain(":root {\n  --color-brand: #0066ff;\n  --color-primary: #0066ff;");
    expect(css).toContain("--space-md: 16;");
    expect(css).toContain('[data-hypen-scheme="dark"] {\n  --color-brand: #66a3ff;\n  --color-primary: #66a3ff;\n  --color-surface: #11111180;\n  --glow-color: #ffffff;\n}');
    expect(css).toContain("@media (prefers-color-scheme: dark) {\n  :root:not([data-hypen-scheme]) {");
    expect(css).toContain('[data-hypen-scheme="sepia"] {\n  --color-surface: #f4ecd8;\n}');
  });

  test("android: typed resources, #AARRGGBB, night overrides", () => {
    const { files, notes } = exportAndroid(theme);
    const day = files["values/hypen_theme.xml"]!;
    expect(day).toContain('<color name="color_primary">#FF0066FF</color>');
    expect(day).toContain('<color name="color_surface">#FFFFFFFF</color>');
    expect(day).toContain('<dimen name="space_md">16dp</dimen>');
    expect(day).toContain('<string name="font_body">Inter</string>');
    expect(day).toContain('<bool name="dense">false</bool>');
    const night = files["values-night/hypen_theme.xml"]!;
    expect(night).toContain('<color name="color_surface">#80111111</color>');
    expect(night).not.toContain("space_md");
    expect(notes.join("\n")).toContain("sepia");
    expect(notes.join("\n")).toContain("color.overlay");
  });

  test("ios: a color set per hex color with a dark appearance where it differs", () => {
    const { files } = exportIos(theme);
    const primary = JSON.parse(files["HypenTheme.xcassets/color.primary.colorset/Contents.json"]!);
    expect(primary.colors).toHaveLength(2);
    expect(primary.colors[0].color.components).toEqual({ red: "0x00", green: "0x66", blue: "0xFF", alpha: "1.000" });
    expect(primary.colors[1].appearances).toEqual([{ appearance: "luminosity", value: "dark" }]);
    expect(primary.colors[1].color.components.red).toBe("0x66");
    expect(files["HypenTheme.xcassets/color.overlay.colorset/Contents.json"]).toBeUndefined();
    const swift = files["HypenTheme.swift"]!;
    expect(swift).toContain('static let colorPrimary = Color("color.primary", bundle: .main)');
    expect(swift).toContain("static let spaceMd: CGFloat = 16");
    expect(swift).toContain('static let fontBody = "Inter"');
  });

  const cli = (args: string[]) =>
    spawnSync("bun", [join(import.meta.dir, "../bin/hypen.ts"), ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, HYPEN_NO_ONBOARDING: "1", NO_COLOR: "1" },
    });

  test("hypen theme export writes every format under the output directory", () => {
    mkdirSync(join(dir, "design"));
    writeFileSync(join(dir, "design/tokens.json"), JSON.stringify(theme));
    writeFileSync(join(dir, "hypen.json"), JSON.stringify({ theme: "./design/tokens.json" }));
    const run = cli(["theme", "export", "--outDir", "out"]);
    expect(run.status).toBe(0);
    expect(existsSync(join(dir, "out/css/theme.css"))).toBe(true);
    expect(existsSync(join(dir, "out/android/values-night/hypen_theme.xml"))).toBe(true);
    expect(existsSync(join(dir, "out/ios/HypenTheme.swift"))).toBe(true);
    expect(run.stdout).toContain("sepia");

    const one = cli(["theme", "export", "--format", "css", "--outDir", "only"]);
    expect(one.status).toBe(0);
    expect(existsSync(join(dir, "only/android"))).toBe(false);
    expect(readFileSync(join(dir, "only/css/theme.css"), "utf-8")).toContain("--color-primary");
  });

  test("hypen theme export refuses a missing file, a bad format and unresolved aliases", () => {
    expect(cli(["theme", "export"]).status).toBe(1);
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ tokens: { a: "{nope}" } }));
    const aliases = cli(["theme", "export"]);
    expect(aliases.status).toBe(1);
    expect(aliases.stderr).toContain('aliases "nope"');
    expect(existsSync(join(dir, "theme-export"))).toBe(false);
    writeFileSync(join(dir, "theme.json"), JSON.stringify(theme));
    expect(cli(["theme", "export", "--format", "flutter"]).status).toBe(1);
    expect(cli(["theme", "frobnicate"]).status).toBe(1);
  });
});
