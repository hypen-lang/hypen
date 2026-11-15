/**
 * A Heading whose level changes after creation, in a REAL browser.
 *
 * The DOM renderer keeps the creation-time `<hN>` (re-tagging would orphan
 * its node map) and sizes the heading like its new level through
 * `data-hypen-level` + the zero-specificity rules in `HEADING_LEVEL_CSS`.
 * fake-dom has no cascade, so the unit test (dom.prop-routing.test.ts) can
 * only check the attribute and the rule text; this checks what Chromium
 * actually computes:
 *
 * - end to end (RemoteServer + the default web client): an `<h1>` re-levelled
 *   to 4 computes the size and block margins of a real `<h4>` beside it,
 *   while a heading with an author `.fontSize(40)` keeps 40px throughout;
 * - the rules reach a heading rendered inside a shadow root (document-level
 *   rules never cross a shadow boundary).
 *
 * Skipped when Chromium is not available (HYPEN_BROWSER_REQUIRE=1 makes that
 * an error).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { app } from "../packages/core/src/app";
import { RemoteServer } from "../packages/server/src/remote/server";

const CANDIDATES = [
  process.env.HYPEN_CHROMIUM_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/opt/pw-browsers/chromium",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].filter((p): p is string => !!p);
const CHROMIUM = CANDIDATES.find((p) => existsSync(p));
let havePlaywright = true;
try {
  require.resolve("playwright-core");
} catch {
  havePlaywright = false;
}
const enabled = !!CHROMIUM && havePlaywright;
if (process.env.HYPEN_BROWSER_REQUIRE === "1" && !enabled) {
  throw new Error("Required browser not found. Set HYPEN_CHROMIUM_PATH.");
}

let browser: import("playwright-core").Browser;
const servers: RemoteServer[] = [];

const UI = `
  Column {
    Heading("Plain", level: "@{state.level}")
    Heading("Sized", level: "@{state.level}").fontSize(40)
    Button { Text("Relevel") }.onClick(@actions.relevel)
  }
`;

async function startServer(): Promise<number> {
  const module = app
    .defineState<{ level: number }>({ level: 1 })
    .onAction("relevel", async ({ state }) => {
      state.level = 4;
    })
    .build();
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = 45000 + Math.floor(Math.random() * 5000);
    const server = new RemoteServer().module("Lab", module).ui(UI);
    try {
      await server.listen(port);
      servers.push(server);
      return port;
    } catch {
      server.stop();
    }
  }
  throw new Error("no free port");
}

interface HeadingInfo {
  tag: string;
  ariaLevel: string | null;
  fontSize: string;
  fontWeight: string;
  marginTop: string;
  marginBottom: string;
}

beforeAll(async () => {
  if (!enabled) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.stop();
});

describe.skipIf(!enabled)("real Chromium: Heading level change", () => {
  test(
    "a re-levelled heading computes the new level's size and margins; an author .fontSize() still wins",
    async () => {
      const port = await startServer();
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      try {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForSelector('[data-hypen-type="heading"]', { timeout: 15_000 });

        const read = () =>
          page.evaluate(() => {
            const headings = Array.from(
              document.querySelectorAll('[data-hypen-type="heading"]')
            ) as HTMLElement[];
            const info = (el: Element) => {
              const cs = getComputedStyle(el);
              return {
                tag: el.tagName.toLowerCase(),
                ariaLevel: el.getAttribute("aria-level"),
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                marginTop: cs.marginTop,
                marginBottom: cs.marginBottom,
              };
            };
            // Real <h1> / <h4> next to the plain heading, same parent: what
            // the browser itself gives those tags in this context.
            const plain = headings.find((h) => h.textContent?.includes("Plain"))!;
            const sized = headings.find((h) => h.textContent?.includes("Sized"))!;
            const ref = (tag: string) => {
              const el = document.createElement(tag);
              el.textContent = "ref";
              plain.parentElement!.appendChild(el);
              const out = info(el);
              el.remove();
              return out;
            };
            return { plain: info(plain), sized: info(sized), h1: ref("h1"), h4: ref("h4") };
          });

        const before = await read();
        expect(before.plain.tag).toBe("h1");
        expect(before.plain.fontSize).toBe(before.h1.fontSize);
        expect(before.sized.fontSize).toBe("40px");

        await page.getByText("Relevel").click();
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll('[data-hypen-type="heading"]')).every(
              (h) => h.getAttribute("data-hypen-level") === "4"
            ),
          undefined,
          { timeout: 10_000 }
        );

        const after = await read();
        const plain: HeadingInfo = after.plain;
        // Same element (no re-tag), announced and sized as level 4.
        expect(plain.tag).toBe("h1");
        expect(plain.ariaLevel).toBe("4");
        expect(plain.fontSize).toBe(after.h4.fontSize);
        expect(plain.fontSize).not.toBe(before.plain.fontSize);
        expect(plain.fontWeight).toBe(after.h4.fontWeight);
        expect(plain.marginTop).toBe(after.h4.marginTop);
        expect(plain.marginBottom).toBe(after.h4.marginBottom);
        // The author's .fontSize(40) beats the zero-specificity level rule.
        expect(after.sized.ariaLevel).toBe("4");
        expect(after.sized.fontSize).toBe("40px");
      } finally {
        await page.close();
      }
    },
    60_000
  );

  test("the level rules reach a heading rendered inside a shadow root", async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../packages/web/src/dom/components/heading.ts")],
      target: "browser",
      format: "esm",
    });
    expect(built.success).toBe(true);
    // Expose the handler on window without a module loader.
    const source = (await built.outputs[0].text()).replace(
      /export\s*\{[^}]*\};?\s*$/,
      "window.__heading = { headingHandler };"
    );
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><html><head></head><body><div id=host></div></body></html>");
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(() => {
        const { headingHandler } = (window as any).__heading;
        const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
        const wrap = document.createElement("div");
        shadow.appendChild(wrap);
        const el = headingHandler.create({ level: 1 }) as HTMLElement;
        headingHandler.applyProps(el, { level: 1, 0: "T" });
        wrap.appendChild(el);
        const ref = document.createElement("h4");
        wrap.appendChild(ref);
        const before = getComputedStyle(el).fontSize;
        headingHandler.applyProps(el, { level: 4 });
        return {
          before,
          after: getComputedStyle(el).fontSize,
          h4: getComputedStyle(ref).fontSize,
          inShadow: !!shadow.getElementById("hypen-heading-level-styles"),
        };
      });
      expect(result.inShadow).toBe(true);
      expect(result.after).toBe(result.h4);
      expect(result.after).not.toBe(result.before);
    } finally {
      await page.close();
    }
  }, 60_000);
});
