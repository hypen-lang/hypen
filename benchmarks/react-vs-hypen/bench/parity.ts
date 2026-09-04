/**
 * Structural parity check.
 *
 * A performance comparison is only worth reading if both sides are actually
 * doing the same work, so this walks the two rendered trees in document order
 * and compares, node for node: tag name, own text, a fixed set of computed
 * styles, and the on-screen rectangle. Any difference is a reason to distrust
 * the timings, so they are reported rather than tolerated.
 *
 *   bun bench/parity.ts [--full]
 *
 * `--full` prints every mismatch instead of the first few.
 */

import { chromium, type Page } from "playwright-core";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serveDir } from "./serve";
import { CHROMIUM_ARGS, CHROMIUM_PATH } from "./browser";
import { ELEMENTS_PER_ROW, PARITY_ROWS } from "../shared/scenarios";

const STYLE_PROPS = [
  "display", "flexDirection", "alignItems", "justifyContent", "flexGrow",
  "flexShrink", "flexBasis", "flexWrap", "gap", "paddingTop", "paddingRight",
  "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom",
  "marginLeft", "width", "height", "minWidth", "minHeight", "boxSizing",
  "backgroundColor", "color", "borderTopWidth", "borderTopStyle",
  "borderTopColor", "borderBottomWidth", "borderBottomColor",
  "borderTopLeftRadius", "fontSize", "fontWeight", "fontFamily", "lineHeight",
  "verticalAlign", "overflowX", "overflowY", "cursor", "textAlign",
];

export interface Node {
  tag: string;
  text: string;
  style: string[];
  rect: [number, number, number, number];
}

async function snapshot(page: Page): Promise<Node[]> {
  return page.evaluate((props: string[]) => {
    const out: Node[] = [] as any;
    const walk = (el: Element) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Own text only: the concatenated text of direct text-node children,
      // so a parent isn't credited with its descendants' content.
      let own = "";
      for (const n of el.childNodes) {
        if (n.nodeType === 3) own += n.nodeValue;
      }
      out.push({
        tag: el.tagName,
        text: own.trim(),
        style: props.map((p) => (cs as any)[p] as string),
        rect: [
          Math.round(r.x), Math.round(r.y),
          Math.round(r.width), Math.round(r.height),
        ],
      });
      for (const c of el.children) walk(c);
    };
    walk(document.getElementById("app")!);
    // The `#app` mount point itself is host chrome, not app output.
    return out.slice(1);
  }, props());

  function props() {
    return STYLE_PROPS;
  }
}

async function load(url: string) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: CHROMIUM_ARGS,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A screenshot of a page the runtime is still churning on can take a while;
  // 30s (the default) has proven too tight when the machine is loaded.
  page.setDefaultTimeout(120000);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction("window.__appReady === true", null, { timeout: 30000 });
  await page.click('[aria-label="parity"]');
  await page.waitForFunction(
    (n: number) =>
      document.querySelectorAll('[aria-label="row-select"]').length === n,
    PARITY_ROWS,
    { timeout: 30000 },
  );
  // Let layout and any transitions settle before measuring rectangles.
  await page.waitForTimeout(600);
  return { browser, page };
}

export interface ParityReport {
  counts: { react: number; hypen: number; expectedRows: number };
  /** SHA-256 of each app's viewport screenshot; equal means pixel-identical. */
  screenshots: { react: string; hypen: string; identical: boolean };
  mismatches: {
    index: number;
    field: string;
    react: string;
    hypen: string;
    tag: string;
  }[];
  identical: boolean;
}

export async function runParity(): Promise<ParityReport> {
  const react = serveDir(resolve(import.meta.dirname, "../apps/react/dist"), 5321);
  const hypen = serveDir(resolve(import.meta.dirname, "../apps/hypen/dist"), 5322);

  const a = await load(react.url);
  const b = await load(hypen.url);

  const left = await snapshot(a.page);
  const right = await snapshot(b.page);

  const shots = resolve(import.meta.dirname, "../results");
  await mkdir(shots, { recursive: true });
  const sha = (buf: Buffer) =>
    createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const reactShot = sha(
    await a.page.screenshot({ path: resolve(shots, "parity-react.png") }),
  );
  const hypenShot = sha(
    await b.page.screenshot({ path: resolve(shots, "parity-hypen.png") }),
  );

  const mismatches: ParityReport["mismatches"] = [];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    if (l.tag !== r.tag) {
      mismatches.push({ index: i, field: "tag", react: l.tag, hypen: r.tag, tag: l.tag });
      // Once the tags diverge the walks are no longer aligned; everything
      // after this point would be noise.
      break;
    }
    if (l.text !== r.text) {
      mismatches.push({ index: i, field: "text", react: l.text, hypen: r.text, tag: l.tag });
    }
    for (let p = 0; p < STYLE_PROPS.length; p++) {
      if (l.style[p] !== r.style[p]) {
        mismatches.push({
          index: i,
          field: `style.${STYLE_PROPS[p]}`,
          react: l.style[p],
          hypen: r.style[p],
          tag: l.tag,
        });
      }
    }
    if (l.rect.join() !== r.rect.join()) {
      mismatches.push({
        index: i,
        field: "rect",
        react: l.rect.join(),
        hypen: r.rect.join(),
        tag: l.tag,
      });
    }
  }

  await a.browser.close();
  await b.browser.close();
  react.stop();
  hypen.stop();

  return {
    counts: {
      react: left.length,
      hypen: right.length,
      expectedRows: PARITY_ROWS * ELEMENTS_PER_ROW,
    },
    screenshots: {
      react: reactShot,
      hypen: hypenShot,
      identical: reactShot === hypenShot,
    },
    identical: mismatches.length === 0 && left.length === right.length,
    mismatches,
  };
}

if (import.meta.main) {
  const full = process.argv.includes("--full");
  const report = await runParity();

  console.log(
    `elements: react=${report.counts.react} hypen=${report.counts.hypen} ` +
      `(${PARITY_ROWS} rows x ${ELEMENTS_PER_ROW} = ${report.counts.expectedRows} + chrome)`,
  );
  console.log(
    `screenshots: ${report.screenshots.identical ? "identical" : "DIFFER"} ` +
      `(${report.screenshots.react} vs ${report.screenshots.hypen})`,
  );
  console.log(`mismatches: ${report.mismatches.length}`);
  for (const m of report.mismatches.slice(0, full ? Infinity : 25)) {
    console.log(
      `  #${m.index} <${m.tag.toLowerCase()}> ${m.field}: ` +
        `react=${JSON.stringify(m.react)} hypen=${JSON.stringify(m.hypen)}`,
    );
  }
  if (!full && report.mismatches.length > 25) {
    console.log(`  ... ${report.mismatches.length - 25} more (--full to see all)`);
  }

  await writeFile(
    resolve(import.meta.dirname, "../results/parity.json"),
    JSON.stringify(report, null, 2),
  );
  process.exit(report.identical ? 0 : 1);
}
