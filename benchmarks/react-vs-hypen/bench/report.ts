/**
 * Turns `results/results.json` into `results/REPORT.md`.
 *
 * Reports medians, because a median over repeated runs is the number that
 * survives an unlucky GC pause; the raw samples stay in the JSON for anyone
 * who wants to check the spread. Ratios are always stated in the direction
 * "X is N× the other", never as a bare "N× faster", so a reader does not have
 * to guess which way round it is.
 */

import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Results } from "./run";

const RESULTS = resolve(import.meta.dirname, "../results");

const results: Results = JSON.parse(
  await readFile(resolve(RESULTS, "results.json"), "utf8"),
);

const ms = (n: number) => `${n.toFixed(1)} ms`;
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

/** "1.8× React" / "0.6× React" — direction always spelled out. */
function ratio(hypen: number, react: number): string {
  if (!react) return "—";
  const r = hypen / react;
  return `${r.toFixed(2)}×`;
}

function winner(hypen: number, react: number, lowerIsBetter = true): string {
  if (hypen === react) return "tie";
  const hypenWins = lowerIsBetter ? hypen < react : hypen > react;
  return hypenWins ? "Hypen" : "React";
}

const lines: string[] = [];
const p = (s = "") => lines.push(s);

p(`# React vs Hypen — same UI, same styles, same DOM`);
p();
p(`Generated ${results.meta.date} · ${results.meta.chromium}`);
p();

// ---------------------------------------------------------------------------

p(`## Parity`);
p();
if (!results.parity) {
  p(`Parity check was skipped for this run.`);
} else {
  const { counts, mismatches, identical } = results.parity;
  p(
    `Both apps rendered **${counts.react}** elements ` +
      `(React) and **${counts.hypen}** (Hypen) for the same 50-row dataset.`,
  );
  p();
  if (identical) {
    p(
      `Walking both trees in document order, every node matched on tag name, ` +
        `own text, 39 computed style properties and its on-screen rectangle. ` +
        `**0 mismatches** — the two apps are pixel-identical, so the timings ` +
        `below compare rendering, not workload.`,
    );
  } else {
    p(`⚠ **${mismatches.length} mismatches** — see \`results/parity.json\`.`);
    p();
    p(`| # | node | field | React | Hypen |`);
    p(`|---|---|---|---|---|`);
    for (const m of mismatches.slice(0, 15)) {
      p(`| ${m.index} | \`${m.tag.toLowerCase()}\` | ${m.field} | \`${m.react}\` | \`${m.hypen}\` |`);
    }
  }
}
p();

// ---------------------------------------------------------------------------

p(`## Interaction latency`);
p();
p(`Median of the timed runs. Each number is the interval from the click to the`);
p(`moment after layout and paint of the frame carrying the last DOM mutation`);
p(`the click caused.`);
p();
p(`| Scenario | React | Hypen | Hypen ÷ React | Faster |`);
p(`|---|--:|--:|--:|---|`);
for (const s of results.scenarios) {
  const flag = s.domMatches ? "" : " ⚠";
  p(
    `| ${s.id}${flag} | ${ms(s.react.median)} | ${ms(s.hypen.median)} | ` +
      `${ratio(s.hypen.median, s.react.median)} | ${winner(s.hypen.median, s.react.median)} |`,
  );
}
p();
p(`<details><summary>Spread (min / median / p95)</summary>`);
p();
p(`| Scenario | React min | React median | React p95 | Hypen min | Hypen median | Hypen p95 |`);
p(`|---|--:|--:|--:|--:|--:|--:|`);
for (const s of results.scenarios) {
  p(
    `| ${s.id} | ${ms(s.react.min)} | ${ms(s.react.median)} | ${ms(s.react.p95)} | ` +
      `${ms(s.hypen.min)} | ${ms(s.hypen.median)} | ${ms(s.hypen.p95)} |`,
  );
}
p();
p(`</details>`);
p();
for (const s of results.scenarios) {
  if (!s.domMatches) {
    p(
      `⚠ \`${s.id}\`: the two apps ended with different DOM ` +
        `(React ${s.domCounts.react.elements} elements / ${s.domCounts.react.rows} rows, ` +
        `Hypen ${s.domCounts.hypen.elements} / ${s.domCounts.hypen.rows}). Treat that row as invalid.`,
    );
    p();
  }
}

// ---------------------------------------------------------------------------

p(`## DOM touched per interaction`);
p();
p(`Every DOM mutation each click produced, counted with a MutationObserver.`);
p(`This is the "did it re-render more than it had to" number: two runtimes can`);
p(`take similar wall-clock time while one rebuilt the list and the other`);
p(`patched a handful of attributes.`);
p();
p(`| Scenario | React nodes ± | React attrs | React text | Hypen nodes ± | Hypen attrs | Hypen text |`);
p(`|---|--:|--:|--:|--:|--:|--:|`);
for (const s of results.scenarios) {
  const w = s.work;
  p(
    `| ${s.id} | +${w.react.added}/−${w.react.removed} | ${w.react.attrs} | ${w.react.text} | ` +
      `+${w.hypen.added}/−${w.hypen.removed} | ${w.hypen.attrs} | ${w.hypen.text} |`,
  );
}
p();

// ---------------------------------------------------------------------------

p(`## Scaling probe — ${results.scaling.react.rows.toLocaleString()} rows`);
p();
p(`A single capped render, reported separately from the table above because it`);
p(`is one sample rather than a median.`);
p();
p(`| | Result |`);
p(`|---|---|`);
for (const app of ["react", "hypen"] as const) {
  const r = results.scaling[app];
  p(
    `| ${app === "react" ? "React" : "Hypen"} | ` +
      (r.ms === null
        ? `did not finish within ${(r.timedOutAfterMs ?? 0) / 1000}s`
        : ms(r.ms)) +
      ` |`,
  );
}
p();

// ---------------------------------------------------------------------------

p(`## Startup`);
p();
p(`| Metric | React | Hypen | Hypen ÷ React |`);
p(`|---|--:|--:|--:|`);
p(
  `| First contentful paint | ${ms(results.startup.react.fcp.median)} | ` +
    `${ms(results.startup.hypen.fcp.median)} | ` +
    `${ratio(results.startup.hypen.fcp.median, results.startup.react.fcp.median)} |`,
);
p(
  `| Interactive (empty shell) | ${ms(results.startup.react.ready.median)} | ` +
    `${ms(results.startup.hypen.ready.median)} | ` +
    `${ratio(results.startup.hypen.ready.median, results.startup.react.ready.median)} |`,
);
p();
p(`Served from localhost with no compression and no network latency, so this`);
p(`is parse + instantiate + first render, not download time.`);
p();

// ---------------------------------------------------------------------------

p(`## Bytes shipped`);
p();
p(`| | React | Hypen |`);
p(`|---|--:|--:|`);
p(
  `| JavaScript | ${kib(results.bundles.react.jsBytes)} (${kib(results.bundles.react.jsGzip)} gzip) | ` +
    `${kib(results.bundles.hypen.jsBytes)} (${kib(results.bundles.hypen.jsGzip)} gzip) |`,
);
p(
  `| WebAssembly | — | ${kib(results.bundles.hypen.wasmBytes)} (${kib(results.bundles.hypen.wasmGzip)} gzip) |`,
);
p(
  `| **Total** | **${kib(results.bundles.react.totalBytes)}** (${kib(results.bundles.react.totalGzip)} gzip) | ` +
    `**${kib(results.bundles.hypen.totalBytes)}** (${kib(results.bundles.hypen.totalGzip)} gzip) |`,
);
p();

// ---------------------------------------------------------------------------

p(`## Memory`);
p();
p(`JS heap after a forced collection.`);
p();
p(`| State | React | Hypen | Hypen ÷ React |`);
p(`|---|--:|--:|--:|`);
for (const [label, key] of [
  ["Empty list", "empty"],
  ["1,000 rows", "after1k"],
  ["Back to empty", "afterClear"],
] as const) {
  p(
    `| ${label} | ${kib(results.memory.react[key])} | ${kib(results.memory.hypen[key])} | ` +
      `${ratio(results.memory.hypen[key], results.memory.react[key])} |`,
  );
}
p();
p(
  `Per-row cost at 1,000 rows: React ` +
    `${(results.memory.react.perRow1k / 1024).toFixed(2)} KiB, Hypen ` +
    `${(results.memory.hypen.perRow1k / 1024).toFixed(2)} KiB. Hypen's figure is` +
    ` JS-heap only — the engine's own node tree lives in WASM linear memory,` +
    ` which this metric does not see.`,
);
p();

await writeFile(resolve(RESULTS, "REPORT.md"), lines.join("\n") + "\n");
console.log("wrote results/REPORT.md");
