// Visual end-to-end: drive `hypen-runtime --serve --ui` in a real (headless)
// browser. Proves the DOM patch-applier in hypen_runtime_client.html actually
// renders a declarative .hypen UI against a wasm module's state, and that
// clicking the rendered Button dispatches → re-renders in place.
//
// Run: CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//      bun scripts/test-serve-ui.mjs
//   (or `npx playwright install chromium` then omit CHROMIUM_EXECUTABLE)

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const bin = resolve(repoRoot, "target/debug/hypen-runtime");
const wasm = resolve(repoRoot, "hypen-engine-rs/tests/fixtures/counter_module.wasm");
const ui = resolve(repoRoot, "hypen-engine-rs/tests/fixtures/counter_ui.hypen");

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}

async function waitForPort(port, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`runtime didn't open port ${port}`);
}

const port = await freePort();
const child = spawn(bin, [wasm, "--scope", "counter", "--ui", ui, "--serve", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (b) => process.stderr.write(`[runtime] ${b}`));

let browser;
let failed = false;
try {
  await waitForPort(port);

  const launchOpts = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE) launchOpts.executablePath = process.env.CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error("[pageerror]", e.message); failed = true; });

  await page.goto(`http://127.0.0.1:${port}/`);

  // The declarative UI renders the wasm module's initial count.
  await page.waitForFunction(() => document.querySelector("#app")?.textContent?.includes("Count: 0"));
  console.log("init      -> #app shows 'Count: 0'  (rendered from wasm state via .hypen)");

  // Click the rendered Button (text "+1", carries data-action=increment).
  await page.click("#app button");
  await page.waitForFunction(() => document.querySelector("#app")?.textContent?.includes("Count: 1"));
  console.log("click +1  -> #app shows 'Count: 1'  (dispatch → wasm reducer → SetProp applied)");

  await page.click("#app button");
  await page.waitForFunction(() => document.querySelector("#app")?.textContent?.includes("Count: 2"));
  console.log("click +1  -> #app shows 'Count: 2'");

  if (failed) throw new Error("page errors occurred");
  console.log("\nPASS: declarative .hypen UI renders + reacts in a real browser, driven by a wasm module.");
} catch (e) {
  console.error("\nFAIL:", e.message);
  failed = true;
} finally {
  if (browser) await browser.close();
  child.kill();
}
process.exit(failed ? 1 : 0);
