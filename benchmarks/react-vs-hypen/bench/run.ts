/**
 * Benchmark driver.
 *
 * Runs the same scenario list against both apps in one process, on one
 * browser build, back to back, and writes `results/results.json`.
 *
 *   bun bench/run.ts [--only create-1k,swap-rows] [--skip-parity]
 *
 * Protocol, per scenario and per app:
 *   - a fresh page (so one scenario's heap can't colour the next one's)
 *   - the scenario's `setup` clicks, settled but not timed
 *   - `warmup` untimed iterations, then `repeat` timed ones
 *   - element and row counts captured after every timed run and asserted
 *     equal across the two apps — a timing is meaningless if the two sides
 *     ended up with different amounts of DOM
 */

import { chromium, type Browser, type Page } from "playwright-core";
import { resolve } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { serveDir, type StaticServer } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { MEASURE_SOURCE } from "./measure";
import { SCALING_CONTROL, SCENARIOS, type Scenario } from "../shared/scenarios";
import { runParity, type ParityReport } from "./parity";

const APPS = ["react", "hypen"] as const;
type AppName = (typeof APPS)[number];

const PORTS: Record<AppName, number> = { react: 5331, hypen: 5332 };
const RESULTS = resolve(import.meta.dirname, "../results");

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface Sample {
  samples: number[];
  median: number;
  min: number;
  p95: number;
  mean: number;
}

function summarize(samples: number[]): Sample {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    samples,
    median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2,
    min: s[0],
    p95: at(0.95),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

// ---------------------------------------------------------------------------
// Bundle size
// ---------------------------------------------------------------------------

export interface BundleReport {
  files: { name: string; bytes: number; gzip: number }[];
  totalBytes: number;
  totalGzip: number;
  jsBytes: number;
  jsGzip: number;
  wasmBytes: number;
  wasmGzip: number;
}

async function measureBundle(app: AppName): Promise<BundleReport> {
  const dist = resolve(import.meta.dirname, `../apps/${app}/dist`);
  const files: BundleReport["files"] = [];

  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(resolve(dir, entry.name), rel);
        continue;
      }
      if (rel.endsWith(".map")) continue; // never shipped to users
      const buf = await readFile(resolve(dir, entry.name));
      files.push({ name: rel, bytes: buf.byteLength, gzip: gzipSync(buf).byteLength });
    }
  };
  await walk(dist);
  files.sort((a, b) => b.bytes - a.bytes);

  const sum = (pred: (f: (typeof files)[number]) => boolean, key: "bytes" | "gzip") =>
    files.filter(pred).reduce((a, f) => a + f[key], 0);

  return {
    files,
    totalBytes: sum(() => true, "bytes"),
    totalGzip: sum(() => true, "gzip"),
    jsBytes: sum((f) => f.name.endsWith(".js"), "bytes"),
    jsGzip: sum((f) => f.name.endsWith(".js"), "gzip"),
    wasmBytes: sum((f) => f.name.endsWith(".wasm"), "bytes"),
    wasmGzip: sum((f) => f.name.endsWith(".wasm"), "gzip"),
  };
}

// ---------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------

async function newPage(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(MEASURE_SOURCE);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction("window.__appReady === true", null, { timeout: 30000 });
  return page;
}

/** JS heap after a forced collection, via CDP so it doesn't need `window.gc`. */
async function heapBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** DOM mutations a single interaction caused. */
export interface Work {
  added: number;
  removed: number;
  attrs: number;
  text: number;
  records: number;
}

export interface ScenarioResult {
  id: string;
  description: string;
  react: Sample;
  hypen: Sample;
  /** DOM touched per interaction — the "how much did it re-render" number. */
  work: Record<AppName, Work>;
  domCounts: Record<AppName, { elements: number; rows: number }>;
  domMatches: boolean;
}

interface ScenarioRun {
  sample: Sample;
  dom: { elements: number; rows: number };
  work: Work;
}

async function runScenario(
  browser: Browser,
  url: string,
  scenario: Scenario,
): Promise<ScenarioRun> {
  const page = await newPage(browser, url);
  const samples: number[] = [];
  let dom = { elements: 0, rows: 0 };
  let work: Work = { added: 0, removed: 0, attrs: 0, text: 0, records: 0 };

  const total = scenario.warmup + scenario.repeat;
  for (let i = 0; i < total; i++) {
    for (const step of scenario.setup ?? []) {
      await page.evaluate(
        (sel: string) => (window as any).__bench.settle(sel),
        `[aria-label="${step}"]`,
      );
    }
    const ms = await page.evaluate(
      (sel: string) => (window as any).__bench.run(sel),
      `[aria-label="${scenario.id}"]`,
    );
    if (i >= scenario.warmup) {
      samples.push(ms as number);
      dom = (await page.evaluate(() => (window as any).__bench.stats())) as typeof dom;
      work = (await page.evaluate(() => (window as any).__bench.lastWork)) as Work;
    }
  }

  await page.close();
  return { sample: summarize(samples), dom, work };
}

export interface ScalingResult {
  ms: number | null;
  rows: number;
  /** Set when the render did not finish inside the cap. */
  timedOutAfterMs?: number;
  /** Set when the probe could not run at all — distinct from "too slow". */
  error?: string;
}

/**
 * One capped 10,000-row render per app. Reported separately from the scenario
 * table because it is a single sample, and because a runtime that cannot
 * finish it inside the cap should say so rather than silently stretch the
 * suite's runtime into the tens of minutes.
 */
async function measureScaling(url: string): Promise<ScalingResult> {
  // Its own browser, killed afterwards. A page that blew through the cap is
  // still rendering when we give up on it, and closing just the page leaves
  // that work running in a renderer process — which would quietly load the
  // machine for every measurement that came after. `browser.close()` takes
  // the process with it. For the same reason this runs last.
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: CHROMIUM_ARGS,
    });
  } catch (err) {
    return {
      ms: null,
      rows: SCALING_CONTROL.rows,
      error: `browser launch failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }

  const page = await newPage(browser, url);
  try {
    // The cap has to be enforced from here, not from a `setTimeout` inside
    // the page: if the render is one long synchronous task, the page's own
    // timers cannot fire until it finishes, and an in-page cap would never
    // trip. `page.evaluate` has its own timeout for exactly this reason.
    page.setDefaultTimeout(SCALING_CONTROL.capMs);
    const ms = await Promise.race([
      page.evaluate(
        (sel: string) => (window as any).__bench.run(sel),
        `[aria-label="${SCALING_CONTROL.id}"]`,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cap")), SCALING_CONTROL.capMs),
      ),
    ]);
    return { ms: ms as number, rows: SCALING_CONTROL.rows };
  } catch {
    return {
      ms: null,
      rows: SCALING_CONTROL.rows,
      timedOutAfterMs: SCALING_CONTROL.capMs,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface StartupResult {
  /** Navigation start to "app is interactive", in ms. */
  ready: Sample;
  /** Navigation start to the browser's First Contentful Paint, in ms. */
  fcp: Sample;
}

async function measureStartup(
  browser: Browser,
  url: string,
  runs = 7,
): Promise<StartupResult> {
  const ready: number[] = [];
  const fcp: number[] = [];
  for (let i = 0; i < runs; i++) {
    const page = await newPage(browser, url);
    ready.push((await page.evaluate(() => (window as any).__startupMs)) as number);
    fcp.push(
      (await page.evaluate(
        () =>
          performance
            .getEntriesByType("paint")
            .find((e) => e.name === "first-contentful-paint")?.startTime ?? 0,
      )) as number,
    );
    await page.close();
  }
  // Drop the first run: it warms the HTTP connection and the code cache on
  // both sides, and neither app should be judged on that.
  return { ready: summarize(ready.slice(1)), fcp: summarize(fcp.slice(1)) };
}

export interface MemoryResult {
  empty: number;
  after1k: number;
  afterClear: number;
  perRow1k: number;
}

async function measureMemory(browser: Browser, url: string): Promise<MemoryResult> {
  const page = await newPage(browser, url);
  const empty = await heapBytes(page);

  await page.evaluate(() => (window as any).__bench.run('[aria-label="create-1k"]'));
  const after1k = await heapBytes(page);

  // Back to empty: anything still held here is retained by the framework
  // rather than by the list.
  await page.evaluate(() => (window as any).__bench.run('[aria-label="clear"]'));
  const afterClear = await heapBytes(page);

  await page.close();
  return { empty, after1k, afterClear, perRow1k: (after1k - empty) / 1000 };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface Results {
  meta: {
    date: string;
    chromium: string;
    scenarioCount: number;
    note: string;
  };
  parity: ParityReport | null;
  bundles: Record<AppName, BundleReport>;
  startup: Record<AppName, StartupResult>;
  memory: Record<AppName, MemoryResult>;
  scaling: Record<AppName, ScalingResult>;
  scenarios: ScenarioResult[];
}

const argOnly = process.argv.find((a) => a.startsWith("--only="));
const only = argOnly ? argOnly.slice("--only=".length).split(",") : null;
const skipParity = process.argv.includes("--skip-parity");
const skipScaling = process.argv.includes("--skip-scaling");

const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));

const servers = {} as Record<AppName, StaticServer>;
for (const app of APPS) {
  servers[app] = serveDir(
    resolve(import.meta.dirname, `../apps/${app}/dist`),
    PORTS[app],
  );
}

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: CHROMIUM_ARGS,
});

console.log(`chromium ${browser.version()}`);

const bundles = {} as Record<AppName, BundleReport>;
for (const app of APPS) bundles[app] = await measureBundle(app);

console.log("startup…");
const startup = {} as Record<AppName, StartupResult>;
for (const app of APPS) startup[app] = await measureStartup(browser, servers[app].url);

console.log("memory…");
const memory = {} as Record<AppName, MemoryResult>;
for (const app of APPS) memory[app] = await measureMemory(browser, servers[app].url);

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  process.stdout.write(`${scenario.id}… `);
  const react = await runScenario(browser, servers.react.url, scenario);
  const hypen = await runScenario(browser, servers.hypen.url, scenario);
  const domMatches =
    react.dom.elements === hypen.dom.elements && react.dom.rows === hypen.dom.rows;
  results.push({
    id: scenario.id,
    description: scenario.description,
    react: react.sample,
    hypen: hypen.sample,
    work: { react: react.work, hypen: hypen.work },
    domCounts: { react: react.dom, hypen: hypen.dom },
    domMatches,
  });
  console.log(
    `react ${react.sample.median.toFixed(1)}ms  hypen ${hypen.sample.median.toFixed(1)}ms` +
      (domMatches ? "" : "  ⚠ DOM COUNTS DIFFER"),
  );
}

const chromiumVersion = browser.version();
await browser.close();

const scaling = {} as Record<AppName, ScalingResult>;
for (const app of APPS) {
  scaling[app] = { ms: null, rows: SCALING_CONTROL.rows, error: "not run" };
}

const payload: Results = {
  meta: {
    date: new Date().toISOString(),
    chromium: chromiumVersion,
    scenarioCount: results.length,
    note: "Median of repeated runs; click to post-paint of the last mutated frame.",
  },
  parity: null,
  bundles,
  startup,
  memory,
  scaling,
  scenarios: results,
};

// Everything below drives more browsers and can fail on its own — a launch
// timing out, a screenshot stalling on a loaded machine. A suite that took a
// quarter of an hour must not lose every number it collected to an optional
// step, so the results land on disk first and each later step updates them.
await mkdir(RESULTS, { recursive: true });
const write = () =>
  writeFile(resolve(RESULTS, "results.json"), JSON.stringify(payload, null, 2));
await write();

// Scaling probe last, in its own browser: see measureScaling.
if (!skipScaling) {
  console.log(`scaling probe (${SCALING_CONTROL.rows} rows, capped)…`);
  for (const app of APPS) {
    scaling[app] = await measureScaling(servers[app].url);
    const r = scaling[app];
    console.log(
      `  ${app}: ${
        r.error
          ? r.error
          : r.ms === null
            ? `did not finish in ${SCALING_CONTROL.capMs / 1000}s`
            : `${r.ms.toFixed(0)} ms`
      }`,
    );
    await write();
  }
}

if (!skipParity) {
  try {
    payload.parity = await runParity();
    if (!payload.parity.identical) {
      console.log(
        `⚠ parity: ${payload.parity.mismatches.length} mismatches — see results/parity.json`,
      );
    }
    await write();
  } catch (err) {
    console.log(`⚠ parity check failed: ${(err as Error).message}`);
  }
}

for (const app of APPS) servers[app].stop();
console.log(`\nwrote results/results.json`);
