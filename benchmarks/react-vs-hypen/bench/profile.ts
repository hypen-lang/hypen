/**
 * Where does the time actually go?
 *
 * Takes a V8 CPU profile across one interaction and attributes self time two
 * ways:
 *
 *   1. by layer — WASM, the wasm-bindgen glue, app/SDK JavaScript, GC, and
 *      everything the browser does outside JS (layout, style, paint), which
 *      V8 reports as `(program)`;
 *   2. by function, for the JavaScript.
 *
 * Layer attribution is the number that decides where to look; the per-function
 * table says what to look at. Profiles are taken against an unminified build
 * (`BENCH_PROFILE=1`) so function names survive — the sampling overhead and
 * missing minification mean the durations here are NOT comparable to the
 * benchmark's timings, and are not reported as such.
 *
 *   bun bench/profile.ts [hypen|react] [scenario]
 */

import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { serveDir } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { MEASURE_SOURCE } from "./measure";

const app = process.argv[2] === "react" ? "react" : "hypen";
const scenario = process.argv[3] ?? "create-1k";

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

/** Which layer a stack frame belongs to. */
function layerOf(f: CallFrame): string {
  const name = f.functionName || "(anonymous)";
  if (name === "(garbage collector)") return "GC";
  if (name === "(program)") return "browser (layout/style/paint/idle)";
  if (name === "(idle)") return "idle";
  if (f.url.endsWith(".wasm") || /^wasm-function|^\$/.test(name)) {
    return "WASM (engine)";
  }
  if (f.url.includes("/wasm/hypen_engine.js")) return "wasm-bindgen glue";
  if (f.url.includes("/assets/")) return "JavaScript (app + SDK)";
  return name.startsWith("(") ? name : "other";
}

const server = serveDir(
  resolve(import.meta.dirname, `../apps/${app}/dist-profile`),
  app === "hypen" ? 5362 : 5361,
);

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: CHROMIUM_ARGS,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(MEASURE_SOURCE);
await page.goto(server.url, { waitUntil: "load" });
await page.waitForFunction("window.__appReady === true", null, { timeout: 30000 });

const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");

const wall = await page.evaluate(
  (sel: string) => (window as any).__bench.run(sel),
  `[aria-label="${scenario}"]`,
);

const { profile } = await cdp.send("Profiler.stop");
await browser.close();
server.stop();

// Self time per node id, from the sample stream.
const selfByNode = new Map<number, number>();
const deltas = profile.timeDeltas ?? [];
const samples = profile.samples ?? [];
for (let i = 0; i < samples.length; i++) {
  const dt = Math.max(0, deltas[i] ?? 0);
  selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + dt);
}

const byLayer = new Map<string, number>();
const byFunction = new Map<string, { us: number; layer: string }>();
let total = 0;

for (const node of profile.nodes) {
  const us = selfByNode.get(node.id) ?? 0;
  if (!us) continue;
  const frame = node.callFrame as CallFrame;
  const layer = layerOf(frame);
  if (layer === "idle") continue;
  total += us;
  byLayer.set(layer, (byLayer.get(layer) ?? 0) + us);

  const file = frame.url.split("/").pop() ?? "";
  const key = `${frame.functionName || "(anonymous)"} — ${file}:${frame.lineNumber + 1}`;
  const prev = byFunction.get(key);
  byFunction.set(key, { us: (prev?.us ?? 0) + us, layer });
}

const pct = (us: number) => `${((us / total) * 100).toFixed(1)}%`;
const ms = (us: number) => `${(us / 1000).toFixed(0)} ms`;

console.log(`\n${app} · ${scenario} · interaction took ${(wall as number).toFixed(0)} ms`);
console.log(`(unminified profiling build; sampled, so treat as a breakdown, not a timing)\n`);

console.log("by layer");
for (const [layer, us] of [...byLayer].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pct(us).padStart(6)}  ${ms(us).padStart(8)}  ${layer}`);
}

console.log("\ntop JavaScript frames by self time");
const js = [...byFunction]
  .filter(([, v]) => v.layer.startsWith("JavaScript") || v.layer === "wasm-bindgen glue")
  .sort((a, b) => b[1].us - a[1].us)
  .slice(0, 20);
for (const [key, v] of js) {
  console.log(`  ${pct(v.us).padStart(6)}  ${ms(v.us).padStart(8)}  ${key}`);
}

const out = resolve(import.meta.dirname, "../results");
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, `profile-${app}-${scenario}.json`),
  JSON.stringify(
    {
      app,
      scenario,
      interactionMs: wall,
      totalSampledUs: total,
      byLayer: Object.fromEntries(byLayer),
      byFunction: Object.fromEntries(
        [...byFunction].sort((a, b) => b[1].us - a[1].us).slice(0, 100),
      ),
    },
    null,
    2,
  ),
);
console.log(`\nwrote results/profile-${app}-${scenario}.json`);
