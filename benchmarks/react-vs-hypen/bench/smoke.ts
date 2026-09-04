/**
 * Quick "does it actually render?" check for one app. Not part of the
 * benchmark — a fast loop for developing the apps.
 *
 *   bun bench/smoke.ts react|hypen [rows]
 */

import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { serveDir } from "./serve";
import { CHROMIUM_PATH } from "./browser";

const which = process.argv[2] === "hypen" ? "hypen" : "react";
const control = process.argv[3] ?? "parity";

const server = serveDir(
  resolve(import.meta.dirname, `../apps/${which}/dist`),
  which === "hypen" ? 5312 : 5311,
);

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log(`  [console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("  [pageerror]", e.message, "\n", e.stack));

await page.goto(server.url, { waitUntil: "load" });
await page.waitForFunction("window.__appReady === true", null, { timeout: 20000 });

await page.click(`[aria-label="${control}"]`);
await page.waitForTimeout(500);

const stats = await page.evaluate(() => {
  const root = document.getElementById("app")!;
  return {
    elements: root.querySelectorAll("*").length,
    cards: root.querySelectorAll('[aria-label="row-select"]').length,
    firstRowText: root.querySelectorAll('[aria-label="row-select"]')[0]
      ?.parentElement?.textContent,
  };
});
console.log(which, stats);

await page.screenshot({
  path: resolve(import.meta.dirname, `../results/smoke-${which}.png`),
});

await browser.close();
server.stop();
