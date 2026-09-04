/**
 * Like profile.ts, but keeps the call tree so self time can be attributed to
 * the *caller* chain. Prints, for the heaviest self-time frames, which stacks
 * they were reached from.
 *
 *   bun bench/profile-tree.ts [hypen|react] [scenario]
 */

import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { serveDir } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { MEASURE_SOURCE } from "./measure";

const app = process.argv[2] === "react" ? "react" : "hypen";
const scenario = process.argv[3] ?? "create-1k";
const setup = process.argv[4];

const server = serveDir(
  resolve(import.meta.dirname, `../apps/${app}/dist-profile`),
  app === "hypen" ? 5372 : 5371,
);

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: CHROMIUM_ARGS,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(MEASURE_SOURCE);
await page.goto(server.url, { waitUntil: "load" });
await page.waitForFunction("window.__appReady === true", null, { timeout: 60000 });

if (setup) {
  await page.evaluate(
    (sel: string) => (window as any).__bench.run(sel),
    `[aria-label="${setup}"]`,
  );
}

const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");

const wall = await page.evaluate(
  (sel: string) => (window as any).__bench.run(sel),
  `[aria-label="${scenario}"]`,
);

const { profile } = await cdp.send("Profiler.stop");
await browser.close();
server.stop();

const nodes = new Map<number, any>();
for (const n of profile.nodes) nodes.set(n.id, n);

const parent = new Map<number, number>();
for (const n of profile.nodes) {
  for (const c of n.children ?? []) parent.set(c, n.id);
}

const selfByNode = new Map<number, number>();
const deltas = profile.timeDeltas ?? [];
const samples = profile.samples ?? [];
for (let i = 0; i < samples.length; i++) {
  const dt = Math.max(0, deltas[i] ?? 0);
  selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + dt);
}

const short = (id: number) => {
  const f = nodes.get(id)?.callFrame;
  if (!f) return "?";
  const name = (f.functionName || "(anon)").replace(/::h[0-9a-f]{16}$/, "");
  return name;
};

/** Walk up to `depth` parents, returning a "a < b < c" chain. */
const chain = (id: number, depth: number) => {
  const out = [short(id)];
  let cur = id;
  for (let i = 0; i < depth; i++) {
    const p = parent.get(cur);
    if (p === undefined) break;
    out.push(short(p));
    cur = p;
  }
  return out.join("  <  ");
};

// Aggregate self time per function *name*, and per full caller chain.
const byName = new Map<string, number>();
const byChain = new Map<string, number>();
let total = 0;
for (const [id, us] of selfByNode) {
  if (!us) continue;
  const name = short(id);
  if (name === "(idle)") continue;
  total += us;
  byName.set(name, (byName.get(name) ?? 0) + us);
  byChain.set(chain(id, 6), (byChain.get(chain(id, 6)) ?? 0) + us);
}

const ms = (us: number) => `${(us / 1000).toFixed(0)} ms`;
const pct = (us: number) => `${((us / total) * 100).toFixed(1)}%`;

console.log(`\n${app} · ${scenario} · interaction ${(wall as number).toFixed(0)} ms · sampled total ${ms(total)}\n`);

console.log("=== top self time by function ===");
for (const [n, us] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${pct(us).padStart(6)} ${ms(us).padStart(9)}  ${n}`);
}

console.log("\n=== top self time by caller chain (callee < caller < ...) ===");
for (const [c, us] of [...byChain].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${pct(us).padStart(6)} ${ms(us).padStart(9)}  ${c}`);
}

await writeFile(
  resolve(import.meta.dirname, `../results/profile-tree-${app}-${scenario}.json`),
  JSON.stringify(
    {
      app,
      scenario,
      interactionMs: wall,
      byName: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1])),
      byChain: Object.fromEntries([...byChain].sort((a, b) => b[1] - a[1]).slice(0, 120)),
    },
    null,
    2,
  ),
);
