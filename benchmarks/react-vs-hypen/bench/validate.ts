/**
 * Cross-check the measurement method.
 *
 * `bench/measure.ts` times a click by watching a MutationObserver and waiting
 * for the DOM to go quiet. If that observer were itself the bottleneck — 17,000
 * insertions produce a lot of records — the numbers would say more about the
 * harness than about the frameworks. This script re-times the same click with
 * no observer at all: it polls the rendered row count on every animation frame
 * and stops when the target is reached. Two independent methods agreeing means
 * the numbers are the frameworks'.
 *
 *   bun bench/validate.ts
 */

import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { serveDir } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { MEASURE_SOURCE } from "./measure";

const POLL_SOURCE = `
window.__poll = (selector, expected) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  document.querySelector(selector).click();
  const tick = () => {
    const n = document.querySelectorAll('[aria-label="row-select"]').length;
    if (n === expected) {
      // One more frame plus a task, so the count reflects painted rows.
      requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
      return;
    }
    if (performance.now() - t0 > 120000) return reject(new Error("timeout"));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
`;

const log = (m: string) => process.stderr.write(`${m}\n`);

for (const app of ["react", "hypen"] as const) {
  const server = serveDir(
    resolve(import.meta.dirname, `../apps/${app}/dist`),
    app === "react" ? 5351 : 5352,
  );
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: CHROMIUM_ARGS,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(MEASURE_SOURCE);
  await page.addInitScript(POLL_SOURCE);
  await page.goto(server.url, { waitUntil: "load" });
  await page.waitForFunction("window.__appReady === true", null, { timeout: 30000 });

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).__bench.settle('[aria-label="clear"]'));
    const observed = await page.evaluate(
      () => (window as any).__bench.run('[aria-label="create-1k"]'),
    );
    await page.evaluate(() => (window as any).__bench.settle('[aria-label="clear"]'));
    const polled = await page.evaluate(
      () => (window as any).__poll('[aria-label="create-1k"]', 1000),
    );
    log(
      `${app} create-1k: observer=${(observed as number).toFixed(1)}ms ` +
        `poll=${(polled as number).toFixed(1)}ms`,
    );
  }

  await browser.close();
  server.stop();
}
