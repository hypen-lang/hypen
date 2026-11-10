/**
 * Matrix driver: N builds, one machine, one browser, interleaved.
 *
 * `bench/run.ts` compares the two apps in this checkout. This driver compares
 * any number of prebuilt variants (`scripts/build-variants.ts`) — React, and
 * the Hypen app bundled against several SDK releases — and is built to make
 * "which one is faster" survive a noisy host:
 *
 *   - Every variant runs in the same process, against the same Chromium, on
 *     the same machine. Nothing is compared across machines.
 *   - Work is interleaved, not batched. A round visits every scenario, and
 *     for each scenario every variant, back to back; the starting variant
 *     rotates every scenario. If the host slows down for a minute, every
 *     variant pays for it roughly equally instead of one of them eating it.
 *   - Each round opens with a fixed calibration workload (pure JS, then DOM
 *     build + layout) that touches no framework. Its spread across rounds is
 *     the host's own noise floor, and is printed next to the results.
 *   - The machine is recorded: CPU model, core count, memory, kernel, load.
 *
 *   bun bench/matrix.ts [--rounds=5] [--only=create-1k,…] [--variants=a,b]
 *                       [--skip-scaling] [--skip-parity] [--out=results/matrix.json]
 *
 * Samples from all rounds are pooled per (scenario, variant); the report
 * (`bench/matrix-report.ts`) reads the pooled median.
 */

import { chromium, type Browser, type Page } from "playwright-core";
import { resolve } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import { serveDir, type StaticServer } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { MEASURE_SOURCE } from "./measure";
import { SCALING_CONTROL, SCENARIOS, type Scenario } from "../shared/scenarios";
import { runParity } from "./parity";
import type { Variant } from "../scripts/build-variants";

const ROOT = resolve(import.meta.dirname, "..");
const VARIANTS_DIR = resolve(ROOT, "variants");

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const ROUNDS = Number(arg("rounds") ?? 5);
const OUT = resolve(ROOT, arg("out") ?? "results/matrix.json");
const SCALING_CAP_MS = Number(arg("scaling-cap-ms") ?? 120000);
const only = arg("only")?.split(",") ?? null;
const pick = arg("variants")?.split(",") ?? null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Work {
  added: number;
  removed: number;
  attrs: number;
  text: number;
  records: number;
}

export interface Cell {
  /** Click to post-paint of the last mutated frame, ms (frame-quantised). */
  samples: number[];
  /**
   * Main-thread time the interaction consumed, ms: Chromium's own
   * `TaskDuration` counter read before and after. Unlike the latency above it
   * is not rounded up to a frame boundary, so it still separates variants
   * whose interactions all fit inside one 16.7 ms frame.
   */
  cpu: number[];
  dom: { elements: number; rows: number };
  work: Work;
}

export interface MatrixResults {
  meta: {
    date: string;
    rounds: number;
    chromium: string;
    bun: string;
    machine: {
      cpuModel: string;
      cpus: number;
      memoryMB: number;
      platform: string;
      kernel: string;
      loadavgStart: number[];
      loadavgEnd: number[];
    };
    /** Free-form label for where this ran (e.g. the sandbox template). */
    host: string;
    durationSec: number;
  };
  variants: (Variant & {
    bundle: { jsBytes: number; jsGzip: number; wasmBytes: number; wasmGzip: number };
  })[];
  /** Framework-free workload, one entry per round: the host's noise floor. */
  calibration: { round: number; jsMs: number; domMs: number }[];
  /** scenario id -> variant name -> pooled samples. */
  scenarios: Record<string, Record<string, Cell>>;
  startup: Record<string, { ready: number[]; fcp: number[] }>;
  memory: Record<string, { empty: number[]; after1k: number[]; afterClear: number[] }>;
  scaling: Record<string, { ms: number | null; rows: number; timedOutAfterMs?: number; domRows?: number }>;
  /** Hypen variant -> node-for-node diff against the plain React app. */
  parity: Record<string, { elements: [number, number]; mismatches: number; error?: string }>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const manifest: Variant[] = JSON.parse(
  await readFile(resolve(VARIANTS_DIR, "manifest.json"), "utf8"),
);
const variants = manifest.filter((v) => !pick || pick.includes(v.name));
if (variants.length === 0) throw new Error("no variants selected");
const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));

async function bundleOf(name: string) {
  const sums = { jsBytes: 0, jsGzip: 0, wasmBytes: 0, wasmGzip: 0 };
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const kind = entry.name.endsWith(".wasm") ? "wasm" : entry.name.endsWith(".js") ? "js" : null;
      if (!kind) continue;
      const buf = await readFile(path);
      sums[`${kind}Bytes`] += buf.byteLength;
      sums[`${kind}Gzip`] += gzipSync(buf).byteLength;
    }
  };
  await walk(resolve(VARIANTS_DIR, name));
  return sums;
}

const servers: Record<string, StaticServer> = {};
variants.forEach((v, i) => {
  servers[v.name] = serveDir(resolve(VARIANTS_DIR, v.name), 5400 + i);
});

const launch = () =>
  chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

const browser = await launch();
const startedAt = Date.now();

const results: MatrixResults = {
  meta: {
    date: new Date().toISOString(),
    rounds: ROUNDS,
    chromium: browser.version(),
    bun: Bun.version,
    machine: {
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpus: os.cpus().length,
      memoryMB: Math.round(os.totalmem() / 1048576),
      platform: `${os.platform()} ${os.arch()}`,
      kernel: os.release(),
      loadavgStart: os.loadavg(),
      loadavgEnd: [],
    },
    host: process.env.BENCH_HOST ?? os.hostname(),
    durationSec: 0,
  },
  variants: await Promise.all(
    variants.map(async (v) => ({ ...v, bundle: await bundleOf(v.name) })),
  ),
  calibration: [],
  scenarios: Object.fromEntries(scenarios.map((s) => [s.id, {}])),
  startup: {},
  memory: {},
  scaling: {},
  parity: {},
};

await mkdir(resolve(OUT, ".."), { recursive: true });
const write = () => {
  results.meta.durationSec = Math.round((Date.now() - startedAt) / 1000);
  results.meta.machine.loadavgEnd = os.loadavg();
  return writeFile(OUT, JSON.stringify(results, null, 2));
};

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

async function newPage(b: Browser, url: string): Promise<Page> {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(MEASURE_SOURCE);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction("window.__appReady === true", null, { timeout: 30000 });
  return page;
}

async function heapBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
}

/**
 * A fixed workload that involves neither framework: a deterministic sort
 * (JS), then building and laying out 20,000 elements (DOM). Best of three.
 */
async function calibrate(round: number): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent("<!doctype html><body><div id=c></div></body>");
  const out = await page.evaluate(() => {
    const js = () => {
      let x = 123456789;
      const a = new Float64Array(400000);
      for (let i = 0; i < a.length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) | 0;
        a[i] = x;
      }
      const t = performance.now();
      a.sort();
      let s = 0;
      for (let i = 0; i < a.length; i += 7) s += Math.sqrt(Math.abs(a[i]));
      return performance.now() - t + (s > 0 ? 0 : 0);
    };
    const dom = () => {
      const c = document.getElementById("c")!;
      c.textContent = "";
      const t = performance.now();
      for (let i = 0; i < 2000; i++) {
        const row = document.createElement("div");
        row.style.display = "flex";
        for (let j = 0; j < 9; j++) {
          const s = document.createElement("span");
          s.textContent = "cell " + i + ":" + j;
          row.appendChild(s);
        }
        c.appendChild(row);
      }
      void c.offsetHeight; // force layout
      return performance.now() - t;
    };
    let jsMs = Infinity;
    let domMs = Infinity;
    for (let i = 0; i < 3; i++) {
      jsMs = Math.min(jsMs, js());
      domMs = Math.min(domMs, dom());
    }
    return { jsMs, domMs };
  });
  await page.close();
  results.calibration.push({ round, ...out });
  console.log(
    `  calibration: js ${out.jsMs.toFixed(1)} ms, dom ${out.domMs.toFixed(1)} ms`,
  );
}

async function runScenario(url: string, scenario: Scenario): Promise<Cell> {
  const page = await newPage(browser, url);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const taskSeconds = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (x) => x.name === "TaskDuration",
    )?.value ?? 0;
  const cell: Cell = {
    samples: [],
    cpu: [],
    dom: { elements: 0, rows: 0 },
    work: { added: 0, removed: 0, attrs: 0, text: 0, records: 0 },
  };
  for (let i = 0; i < scenario.warmup + scenario.repeat; i++) {
    for (const step of scenario.setup ?? []) {
      await page.evaluate(
        (sel: string) => (window as any).__bench.settle(sel),
        `[aria-label="${step}"]`,
      );
    }
    const before = await taskSeconds();
    const ms = (await page.evaluate(
      (sel: string) => (window as any).__bench.run(sel),
      `[aria-label="${scenario.id}"]`,
    )) as number;
    const cpuMs = ((await taskSeconds()) - before) * 1000;
    if (i >= scenario.warmup) {
      cell.samples.push(ms);
      cell.cpu.push(cpuMs);
      cell.dom = await page.evaluate(() => (window as any).__bench.stats());
      cell.work = await page.evaluate(() => (window as any).__bench.lastWork);
    }
  }
  await page.close();
  return cell;
}

async function measureStartup(name: string, url: string): Promise<void> {
  const slot = (results.startup[name] ??= { ready: [], fcp: [] });
  // First load of the batch warms the connection and code cache; dropped.
  for (let i = 0; i < 4; i++) {
    const page = await newPage(browser, url);
    const ready = (await page.evaluate(() => (window as any).__startupMs)) as number;
    const fcp = (await page.evaluate(
      () =>
        performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint")
          ?.startTime ?? 0,
    )) as number;
    await page.close();
    if (i > 0) {
      slot.ready.push(ready);
      slot.fcp.push(fcp);
    }
  }
}

async function measureMemory(name: string, url: string): Promise<void> {
  const slot = (results.memory[name] ??= { empty: [], after1k: [], afterClear: [] });
  const page = await newPage(browser, url);
  slot.empty.push(await heapBytes(page));
  await page.evaluate(() => (window as any).__bench.run('[aria-label="create-1k"]'));
  slot.after1k.push(await heapBytes(page));
  await page.evaluate(() => (window as any).__bench.run('[aria-label="clear"]'));
  slot.afterClear.push(await heapBytes(page));
  await page.close();
}

/** One capped 10,000-row render, in its own browser (see bench/run.ts). */
async function measureScaling(name: string, url: string): Promise<void> {
  const b = await launch();
  const page = await newPage(b, url);
  try {
    page.setDefaultTimeout(SCALING_CAP_MS);
    const ms = (await Promise.race([
      page.evaluate(
        (sel: string) => (window as any).__bench.run(sel),
        `[aria-label="${SCALING_CONTROL.id}"]`,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cap")), SCALING_CAP_MS),
      ),
    ])) as number;
    const dom = (await page.evaluate(() => (window as any).__bench.stats())) as Cell["dom"];
    results.scaling[name] = { ms, rows: SCALING_CONTROL.rows, domRows: dom.rows };
  } catch {
    results.scaling[name] = {
      ms: null,
      rows: SCALING_CONTROL.rows,
      timedOutAfterMs: SCALING_CAP_MS,
    };
  } finally {
    await b.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const m = results.meta.machine;
console.log(
  `${m.cpuModel} · ${m.cpus} cpus · ${m.memoryMB} MB · chromium ${results.meta.chromium}`,
);
console.log(`${variants.length} variants × ${scenarios.length} scenarios × ${ROUNDS} rounds`);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

for (let round = 0; round < ROUNDS; round++) {
  console.log(`round ${round + 1}/${ROUNDS}`);
  await calibrate(round);

  const rotated = (offset: number) =>
    variants.map((_, i) => variants[(i + offset) % variants.length]);

  for (const v of rotated(round)) await measureStartup(v.name, servers[v.name].url);
  for (const v of rotated(round)) await measureMemory(v.name, servers[v.name].url);

  for (let si = 0; si < scenarios.length; si++) {
    const scenario = scenarios[si];
    const line: string[] = [];
    for (const v of rotated(round + si)) {
      const cell = await runScenario(servers[v.name].url, scenario);
      const slot = results.scenarios[scenario.id][v.name];
      if (slot) {
        slot.samples.push(...cell.samples);
        slot.cpu.push(...cell.cpu);
        slot.dom = cell.dom;
        slot.work = cell.work;
      } else {
        results.scenarios[scenario.id][v.name] = cell;
      }
      line.push(`${v.name} ${median(cell.samples).toFixed(1)}`);
    }
    console.log(`  ${scenario.id}: ${line.join(" · ")}`);
  }
  await write();
}

await browser.close();

if (!flag("skip-scaling")) {
  console.log(`scaling probe (${SCALING_CONTROL.rows} rows, cap ${SCALING_CAP_MS / 1000}s)`);
  for (const v of variants) {
    await measureScaling(v.name, servers[v.name].url);
    const r = results.scaling[v.name];
    console.log(`  ${v.name}: ${r.ms === null ? "did not finish" : `${r.ms.toFixed(0)} ms`}`);
    await write();
  }
}

for (const name of Object.keys(servers)) servers[name].stop();

if (!flag("skip-parity") && variants.some((v) => v.name === "react")) {
  console.log("parity vs react");
  for (const v of variants) {
    if (v.framework !== "hypen" || v.virtualized) continue;
    try {
      const p = await runParity({
        reactDist: resolve(VARIANTS_DIR, "react"),
        hypenDist: resolve(VARIANTS_DIR, v.name),
        shotPrefix: `parity-${v.name}`,
      });
      results.parity[v.name] = {
        elements: [p.counts.react, p.counts.hypen],
        mismatches: p.mismatches.length,
      };
    } catch (err) {
      results.parity[v.name] = {
        elements: [0, 0],
        mismatches: -1,
        error: (err as Error).message.split("\n")[0],
      };
    }
    console.log(`  ${v.name}: ${results.parity[v.name].mismatches} mismatches`);
  }
}

await write();
console.log(`wrote ${OUT} in ${results.meta.durationSec}s`);
process.exit(0);
