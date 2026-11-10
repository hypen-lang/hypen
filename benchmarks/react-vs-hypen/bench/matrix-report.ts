/**
 * Turns `results/matrix.json` (bench/matrix.ts) into `results/MATRIX.md`.
 *
 *   bun bench/matrix-report.ts [--in=results/matrix.json] [--out=results/MATRIX.md]
 *                              [--replicate=results/matrix-b.json]
 *
 * `--replicate` is a second, independent run of the same builds (another
 * machine of the same shape). Absolute times differ between machines; what a
 * replicate checks is that the *ratios* hold, so the report prints both.
 */

import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { MatrixResults } from "./matrix";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const load = async (path: string): Promise<MatrixResults> =>
  JSON.parse(await readFile(resolve(ROOT, path), "utf8"));

const r = await load(arg("in") ?? "results/matrix.json");
const rep = arg("replicate") ? await load(arg("replicate")!) : null;
const OUT = resolve(ROOT, arg("out") ?? "results/MATRIX.md");

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const geomean = (xs: number[]) =>
  Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const ms = (x: number) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x.toFixed(1)) : "–");
const times = (x: number) => (Number.isFinite(x) ? `${x.toFixed(2)}×` : "–");
const kb = (b: number) => `${(b / 1024).toFixed(0)} kB`;
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

const names = r.variants.map((v) => v.name);
const eager = r.variants.filter((v) => !v.virtualized).map((v) => v.name);
const windowed = r.variants
  .filter((v) => v.virtualized)
  .map((v) => v.name)
  .sort((a, b) => Number(b === "react-virtual") - Number(a === "react-virtual"));
const scenarioIds = Object.keys(r.scenarios);

type Metric = "samples" | "cpu";
const cell = (res: MatrixResults, id: string, name: string, metric: Metric) =>
  median(res.scenarios[id]?.[name]?.[metric] ?? []);

const lines: string[] = [];
const out = (s = "") => lines.push(s);

function table(head: string[], rows: string[][]) {
  out(`| ${head.join(" | ")} |`);
  out(`|${head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`);
  for (const row of rows) out(`| ${row.join(" | ")} |`);
  out();
}

/** Scenario table for one group of variants, each shown as `ms (ratio vs base)`. */
function scenarioTable(group: string[], base: string, metric: Metric, res = r) {
  const rows = scenarioIds.map((id) => {
    const b = cell(res, id, base, metric);
    return [
      `\`${id}\``,
      ...group.map((n) => {
        const v = cell(res, id, n, metric);
        return n === base ? ms(v) : `${ms(v)} (${times(v / b)})`;
      }),
    ];
  });
  rows.push([
    "**geomean vs " + base + "**",
    ...group.map((n) =>
      n === base
        ? "1.00×"
        : `**${times(
            geomean(scenarioIds.map((id) => cell(res, id, n, metric) / cell(res, id, base, metric))),
          )}**`,
    ),
  ]);
  table(["scenario", ...group], rows);
}

const m = r.meta.machine;
out("# React vs Hypen — version matrix");
out();
out(
  `Run ${r.meta.date.slice(0, 16).replace("T", " ")} UTC on **${r.meta.host}**: ` +
    `${m.cpuModel}, ${m.cpus} vCPU, ${m.memoryMB} MB, ${m.platform} ${m.kernel}. ` +
    `Chromium ${r.meta.chromium}, Bun ${r.meta.bun}. ` +
    `${r.meta.rounds} interleaved rounds, ${Math.round(r.meta.durationSec / 60)} min.`,
);
out();
out(
  "Every build below ran in the same process against the same browser on the " +
    "same machine, round-robin, with the starting build rotated every scenario " +
    "(`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.",
);
out();

out("## Builds");
out();
table(
  ["build", "what it is", "list", "JS (gzip)", "WASM (gzip)"],
  r.variants.map((v) => [
    `\`${v.name}\``,
    v.source,
    v.virtualized ? "windowed" : "every row in the DOM",
    `${kb(v.bundle.jsBytes)} (${kb(v.bundle.jsGzip)})`,
    v.bundle.wasmBytes ? `${kb(v.bundle.wasmBytes)} (${kb(v.bundle.wasmGzip)})` : "–",
  ]),
);

out("## Host stability");
out();
const cj = r.calibration.map((c) => c.jsMs);
const cd = r.calibration.map((c) => c.domMs);
const spread = (xs: number[]) =>
  `${ms(Math.min(...xs))}–${ms(Math.max(...xs))} ms (±${(
    ((Math.max(...xs) - Math.min(...xs)) / 2 / median(xs)) *
    100
  ).toFixed(1)}%)`;
out(
  `A fixed framework-free workload runs at the start of every round. Across ` +
    `${r.calibration.length} rounds: JS ${spread(cj)}, DOM build + layout ${spread(cd)}. ` +
    `Load average ${m.loadavgStart[0].toFixed(2)} at start, ${(m.loadavgEnd[0] ?? 0).toFixed(2)} at end. ` +
    `Differences between builds smaller than that spread are noise.`,
);
out();

if (eager.length > 1) {
  out("## Every row in the DOM — interaction latency");
  out();
  out(
    "Click to post-paint of the last mutated frame, in ms, and the ratio to " +
      "`react` (above 1× is slower than React). This number is rounded up to a " +
      "frame boundary, so anything that fits in one frame reads ~16 ms for everyone.",
  );
  out();
  scenarioTable(eager, "react", "samples");

  out("## Every row in the DOM — main-thread CPU per interaction");
  out();
  out(
    "Chromium's `TaskDuration` counter, read before and after each interaction " +
      "(script + WASM + style + layout + paint on the main thread), in ms. Not " +
      "frame-quantised, so it separates the builds on the small updates.",
  );
  out();
  scenarioTable(eager, "react", "cpu");
}

if (windowed.length > 1 && windowed.includes("react-virtual")) {
  out("## Windowed lists");
  out();
  out(
    "`react-virtual` is the React app with TanStack Virtual; the Hypen build is " +
      "one whose `List` is virtualized by default. Both keep only the rows near " +
      "the viewport in the DOM, so most interactions fit in a single frame and the " +
      "latency column is mostly the frame clock — read the CPU column.",
  );
  out();
  for (const metric of ["samples", "cpu"] as const) {
    out(metric === "samples" ? "Latency (ms):" : "Main-thread CPU (ms):");
    out();
    scenarioTable(windowed, "react-virtual", metric);
  }
  out("Rows actually in the DOM after each scenario:");
  out();
  table(
    ["scenario", ...windowed],
    scenarioIds.map((id) => [
      `\`${id}\``,
      ...windowed.map((n) => String(r.scenarios[id][n]?.dom.rows ?? "–")),
    ]),
  );
}

out("## DOM work per interaction");
out();
out("Nodes added / removed / attribute writes / text writes, from a MutationObserver.");
out();
table(
  ["scenario", ...names],
  scenarioIds.map((id) => [
    `\`${id}\``,
    ...names.map((n) => {
      const w = r.scenarios[id][n]?.work;
      return w ? `${w.added}/${w.removed}/${w.attrs}/${w.text}` : "–";
    }),
  ]),
);

out("## Startup, memory, 10,000 rows");
out();
table(
  ["build", "ready (ms)", "heap empty", "heap @1k rows", "heap after clear", "create 10k (ms)", "rows in DOM"],
  r.variants.map((v) => {
    const mem = r.memory[v.name];
    const sc = r.scaling[v.name];
    return [
      `\`${v.name}\``,
      ms(median(r.startup[v.name]?.ready ?? [])),
      mem ? mb(median(mem.empty)) : "–",
      mem ? mb(median(mem.after1k)) : "–",
      mem ? mb(median(mem.afterClear)) : "–",
      !sc ? "–" : sc.ms === null ? `> ${sc.timedOutAfterMs! / 1000}s` : ms(sc.ms),
      sc?.domRows !== undefined ? String(sc.domRows) : "–",
    ];
  }),
);
out(
  "Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM " +
    "linear memory, which this does not see. The 10k render is a single sample.",
);
out();

if (Object.keys(r.parity).length) {
  out("## Parity with the React app");
  out();
  out(
    "50 rows rendered in both, every node compared (tag, text, 39 computed " +
      "styles, rectangle). Windowed builds are not compared: they render a " +
      "different number of rows by design.",
  );
  out();
  table(
    ["build", "elements (react / hypen)", "mismatches"],
    Object.entries(r.parity).map(([n, p]) => [
      `\`${n}\``,
      `${p.elements[0]} / ${p.elements[1]}`,
      p.error ? `error: ${p.error}` : String(p.mismatches),
    ]),
  );
}

out("## Spread");
out();
out("Latency, 25th–75th percentile of the pooled samples (ms), and sample count.");
out();
table(
  ["scenario", "n", ...names],
  scenarioIds.map((id) => [
    `\`${id}\``,
    String(r.scenarios[id][names[0]]?.samples.length ?? 0),
    ...names.map((n) => {
      const s = r.scenarios[id][n]?.samples ?? [];
      return s.length ? `${ms(quantile(s, 0.25))}–${ms(quantile(s, 0.75))}` : "–";
    }),
  ]),
);

if (rep) {
  const rm = rep.meta.machine;
  out("## Replicate");
  out();
  out(
    `The same builds, run independently on **${rep.meta.host}** ` +
      `(${rm.cpuModel}, ${rm.cpus} vCPU, ${rm.memoryMB} MB; calibration JS ` +
      `${ms(median(rep.calibration.map((c) => c.jsMs)))} ms vs ` +
      `${ms(median(cj))} ms here). Geomean ratio to the baseline, this run → replicate:`,
  );
  out();
  const gm = (res: MatrixResults, n: string, base: string, metric: Metric) =>
    geomean(scenarioIds.map((id) => cell(res, id, n, metric) / cell(res, id, base, metric)));
  const rows: string[][] = [];
  for (const n of names) {
    const base = windowed.includes(n) ? "react-virtual" : "react";
    if (n === base || !names.includes(base)) continue;
    rows.push([
      `\`${n}\` vs \`${base}\``,
      `${times(gm(r, n, base, "samples"))} → ${times(gm(rep, n, base, "samples"))}`,
      `${times(gm(r, n, base, "cpu"))} → ${times(gm(rep, n, base, "cpu"))}`,
    ]);
  }
  table(["build", "latency", "CPU"], rows);
}

await writeFile(OUT, lines.join("\n"));
console.log(`wrote ${OUT}`);
