/**
 * List virtualization in a REAL browser (docs/virtualization.md §2–§3).
 *
 * fake-dom has no layout, so the unit tests (dom-virtualization.test.ts)
 * cannot see how the stand-in space interacts with the list's own box. This
 * drives the default web client (RemoteEngine + DOMRenderer) served by a real
 * RemoteServer in headless Chromium and checks, for a list that scrolls
 * itself (`.height(480)`) and for a list the page scrolls:
 *
 * - the first paint materializes only the initial window;
 * - the fixed-height list stays its declared height (stand-in space used to
 *   be padding, which on a `border-box` element inflated the list to the
 *   full virtual extent, so it reported [0, total] and the engine streamed
 *   every row);
 * - every viewport report is small;
 * - scrolling to the middle shows the right rows where the viewport is, with
 *   a bounded number of patches per scroll.
 *
 * Skipped when Chromium is not available.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { app } from "../packages/core/src/app";
import { RemoteServer } from "../packages/server/src/remote/server";

const CANDIDATES = [
  process.env.HYPEN_CHROMIUM_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/opt/pw-browsers/chromium",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].filter((p): p is string => !!p);
const CHROMIUM = CANDIDATES.find((p) => existsSync(p));
let havePlaywright = true;
try {
  require.resolve("playwright-core");
} catch {
  havePlaywright = false;
}
const enabled = !!CHROMIUM && havePlaywright;
if (process.env.HYPEN_BROWSER_REQUIRE === "1" && !enabled) {
  throw new Error("Required browser not found. Set HYPEN_CHROMIUM_PATH.");
}

const TOTAL = 10_000;
const LIST_HEIGHT = 480;

type Row = { id: number; name: string };
const rows = (): Row[] => Array.from({ length: TOTAL }, (_, i) => ({ id: i, name: `Row ${i}` }));

interface Case {
  fixed: boolean;
  /** Author gap and padding on the list (spacers must not double-count them). */
  styled: boolean;
}
const PAD = 16;
const GAP = 8;

const listUi = ({ fixed, styled }: Case) => `
  Column {
    Text("Header").padding(12)
    List(@state.rows, key: "id"${styled ? `, gap: ${GAP}` : ""}) {
      Row { Text("@{item.name}").padding(12) }
    }${fixed ? `.height(${LIST_HEIGHT})` : ""}${styled ? `.padding(${PAD})` : ""}
    Text("Footer").padding(12)
  }
`;

let browser: import("playwright-core").Browser;
const servers: RemoteServer[] = [];

async function startServer(c: Case): Promise<number> {
  const module = app.defineState<{ rows: Row[] }>({ rows: rows() }).build();
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = 45000 + Math.floor(Math.random() * 5000);
    const server = new RemoteServer().module("Lab", module).ui(listUi(c));
    try {
      await server.listen(port);
      servers.push(server);
      return port;
    } catch {
      server.stop();
    }
  }
  throw new Error("no free port");
}

interface Probe {
  page: import("playwright-core").Page;
  /** Patches received after the initial tree, total. */
  patches: () => number;
  viewports: Array<{ start: number; end: number }>;
  settle: () => Promise<void>;
}

async function open(port: number): Promise<Probe> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  let patches = 0;
  let lastFrame = Date.now();
  const viewports: Array<{ start: number; end: number }> = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      lastFrame = Date.now();
      if (typeof f.payload !== "string") return;
      try {
        const msg = JSON.parse(f.payload);
        if (msg.type === "patch" && Array.isArray(msg.patches)) patches += msg.patches.length;
      } catch {}
    });
    ws.on("framesent", (f) => {
      lastFrame = Date.now();
      if (typeof f.payload !== "string") return;
      try {
        const msg = JSON.parse(f.payload);
        if (msg.type === "viewport") viewports.push({ start: msg.start, end: msg.end });
      } catch {}
    });
  });
  const settle = async () => {
    // Quiet for 400 ms (frames both ways), bounded at 10 s.
    const deadline = Date.now() + 10_000;
    await page.waitForTimeout(200);
    while (Date.now() - lastFrame < 400 && Date.now() < deadline) await page.waitForTimeout(100);
  };
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('[data-hypen-type="list"] > *', { timeout: 15_000 });
  await settle();
  return { page, patches: () => patches, viewports, settle };
}

/** Geometry of the (only) list and the row at the top of its visible area. */
function listInfo(page: import("playwright-core").Page, fixed: boolean, inset: number) {
  return page.evaluate(({ fixed, inset }) => {
    const list = document.querySelector('[data-hypen-type="list"]') as HTMLElement;
    const r = list.getBoundingClientRect();
    // The first on-screen point inside the list's visible area.
    const top = (fixed ? r.top : Math.max(r.top, 0)) + inset + 5;
    let hit = document.elementFromPoint(r.left + 20, top) as HTMLElement | null;
    while (hit && hit.parentElement !== list) hit = hit.parentElement;
    const m = hit ? /Row (\d+)/.exec(hit.textContent ?? "") : null;
    const firstRow = list.firstElementChild as HTMLElement | null;
    const second = firstRow?.nextElementSibling as HTMLElement | null;
    return {
      pitch: firstRow && second ? second.getBoundingClientRect().top - firstRow.getBoundingClientRect().top : 0,
      domRows: list.children.length,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      height: r.height,
      top: r.top + window.scrollY,
      rowHeight: firstRow ? firstRow.getBoundingClientRect().height : 0,
      visibleRow: m ? Number(m[1]) : null,
    };
  }, { fixed, inset });
}

beforeAll(async () => {
  if (!enabled) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.stop();
});

describe.skipIf(!enabled)("real Chromium: windowed List", () => {
  const cases: Case[] = [
    { fixed: true, styled: false },
    { fixed: false, styled: false },
    { fixed: true, styled: true },
    { fixed: false, styled: true },
  ];
  for (const c of cases) {
    const { fixed, styled } = c;
    const pad = styled ? PAD : 0;
    const label =
      (fixed ? "fixed-height list scrolls itself" : "page-scrolled list") + (styled ? " (author gap + padding)" : "");
    test(
      label,
      async () => {
        const port = await startServer(c);
        const probe = await open(port);
        const { page } = probe;
        try {
          const initial = await listInfo(page, fixed, pad);
          // Only the initial window is materialized.
          expect(initial.domRows).toBeGreaterThanOrEqual(5);
          expect(initial.domRows).toBeLessThanOrEqual(150);
          expect(initial.rowHeight).toBeGreaterThan(10);
          const pitch = initial.pitch;
          expect(Math.abs(pitch - initial.rowHeight - (styled ? GAP : 0))).toBeLessThanOrEqual(1);
          if (fixed) {
            // The list keeps its declared box; the stand-in lives in its
            // scroll content.
            expect(Math.abs(initial.clientHeight - LIST_HEIGHT)).toBeLessThanOrEqual(2);
            expect(Math.abs(initial.height - LIST_HEIGHT)).toBeLessThanOrEqual(2);
            expect(initial.scrollHeight).toBeGreaterThan(TOTAL * pitch * 0.8);
          } else {
            // The list grows to its full virtual extent; the page scrolls.
            expect(initial.height).toBeGreaterThan(TOTAL * pitch * 0.8);
            expect(initial.height).toBeLessThan(TOTAL * pitch * 1.2);
          }
          expect(initial.visibleRow).toBe(0);
          // The first paint asked for no more than a few hundred rows.
          expect(probe.patches()).toBeLessThan(2_000);

          // Scroll to the middle.
          const target = Math.round(TOTAL * pitch * 0.5);
          const before = probe.patches();
          await page.evaluate(
            ({ fixed, target, top }) => {
              const list = document.querySelector('[data-hypen-type="list"]') as HTMLElement;
              if (fixed) list.scrollTop = target;
              else window.scrollTo(0, top + target);
            },
            { fixed, target, top: initial.top }
          );
          await probe.settle();
          const mid = await listInfo(page, fixed, pad);
          const midPatches = probe.patches() - before;
          // Row `i` starts at pad + i * pitch inside the list: the spacer holds
          // exactly the rows before the window, gaps included, after the
          // author padding.
          const expected = Math.floor((target - pad) / pitch);
          expect(mid.visibleRow).not.toBeNull();
          expect(Math.abs(mid.visibleRow! - expected)).toBeLessThanOrEqual(2);
          expect(mid.domRows).toBeLessThanOrEqual(150);
          expect(midPatches).toBeGreaterThan(0);
          expect(midPatches).toBeLessThan(2_000);
          if (fixed) expect(Math.abs(mid.clientHeight - LIST_HEIGHT)).toBeLessThanOrEqual(2);

          // A further scroll past the window costs a bounded batch.
          const before2 = probe.patches();
          const midRow = mid.visibleRow!;
          await page.evaluate((fixed) => {
            const list = document.querySelector('[data-hypen-type="list"]') as HTMLElement;
            if (fixed) list.scrollTop += 2000;
            else window.scrollBy(0, 2000);
          }, fixed);
          await probe.settle();
          const after = await listInfo(page, fixed, pad);
          expect(probe.patches() - before2).toBeLessThan(1_000);
          expect(Math.abs(after.visibleRow! - (midRow + Math.round(2000 / pitch)))).toBeLessThanOrEqual(3);

          // Every report the client made is a small range.
          expect(probe.viewports.length).toBeGreaterThan(0);
          for (const v of probe.viewports) expect(v.end - v.start).toBeLessThanOrEqual(300);
          // eslint-disable-next-line no-console
          console.log(
            `[${fixed ? "fixed" : "page"}${styled ? "+styled" : ""}] initial rows=${initial.domRows} ch=${initial.clientHeight} h=${Math.round(initial.height)} ` +
              `sh=${initial.scrollHeight}; mid row=${mid.visibleRow} (want ${expected}) rows=${mid.domRows} patches=${midPatches}; ` +
              `next scroll patches=${probe.patches() - before2}; reports=${JSON.stringify(probe.viewports)}`
          );
        } finally {
          await page.close();
        }
      },
      90_000
    );
  }
});
