// Headless smoke test for the browser host. Boots the static server,
// drives the page with Playwright, asserts the same end-to-end loop the
// Node spike validates: init -> 3x increment -> sync -> reload -> recover.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 3001;
process.env.PORT = String(PORT);

// Spin the server.
const server = spawn(
  process.execPath,
  ['scripts/serve.mjs'],
  { stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
);
await new Promise((resolveReady) => {
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('serving')) resolveReady();
  });
});

let exitCode = 0;
let browser;
try {
  // Allow pinning a pre-installed Chromium so the test works in CI sandboxes
  // that don't ship the exact build playwright npm-installs.
  const launchOpts = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE) launchOpts.executablePath = process.env.CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('pageerror', (err) => {
    console.error('[page error]', err.message);
    exitCode = 1;
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('[browser console]', msg.text());
      exitCode = 1;
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  // __spike is only set AFTER first init() returns, so its presence is
  // a real readiness signal.
  await page.waitForFunction(() => typeof window.__spike === 'object');

  const initial = await page.evaluate(() => window.__spike.getState());
  console.log('init           ->', initial);
  if (JSON.parse(initial).count !== 0) throw new Error(`fresh state should be {count:0}, got ${initial}`);

  for (let i = 0; i < 3; i++) {
    await page.click('#increment');
  }
  const afterInc = await page.evaluate(() => window.__spike.getState());
  console.log('after 3 incs   ->', afterInc);
  if (JSON.parse(afterInc).count !== 3) throw new Error(`expected 3, got ${afterInc}`);

  await page.click('#sync');
  const stores = await page.evaluate(() => {
    const s = window.__spike.dumpStores();
    return JSON.parse(JSON.stringify(s));
  });
  console.log('stores         ->', JSON.stringify(stores, null, 2));
  const cloudKey = Object.keys(stores.cloud)[0];
  if (!cloudKey) throw new Error('sync did not populate cloud');
  if (stores.cloud[cloudKey].version !== '1') {
    throw new Error(`cloud version should be 1, got ${stores.cloud[cloudKey].version}`);
  }

  // Reload — the page state is gone, but localStorage and so the module's
  // init() should recover count=3.
  await page.reload();
  await page.waitForFunction(() => typeof window.__spike === 'object');
  const warm = await page.evaluate(() => window.__spike.getState());
  console.log('after reload   ->', warm);
  if (JSON.parse(warm).count !== 3) throw new Error(`warm start expected 3, got ${warm}`);

  // Cleanup leftover localStorage so reruns are deterministic.
  await page.evaluate(() => window.localStorage.clear());

  console.log('\nPASS: browser host runs the full reducer + storage loop.');
} catch (err) {
  console.error('\nFAIL:', err.message);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  process.exit(exitCode);
}
