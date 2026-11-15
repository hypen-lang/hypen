#!/usr/bin/env bun
/**
 * Real-browser harness for @hypen-space/module-host (headless Chromium via
 * Playwright). Run with `bun run test:browser` (builds dist/ first).
 *
 *   1. Bun.build (target: browser) bundles tests/browser/entry.ts against the
 *      BUILT package (dist/), and copies jco-transpile's vendored bindgen
 *      wasm next to the bundle the way a consumer's build must (Bun leaves
 *      jco's `new URL('../vendor/…', import.meta.url)` untouched).
 *   2. A static server on 127.0.0.1:<random> serves the bundle, the vendor
 *      wasm, and the component fixtures (gzip when accepted, nosniff,
 *      per-page Content-Security-Policy chosen by `?csp=`). A second origin
 *      serves the wasi:http target with CORS headers.
 *   3. Scenarios run in fresh pages; console errors and page errors fail the
 *      run unless the scenario declares them expected.
 *
 * Exit codes: 0 = pass (or SKIP when Playwright/Chromium is unavailable),
 * 1 = failure. Set HYPEN_BROWSER_TEST_REQUIRED=1 to turn a SKIP into a
 * failure (CI with a browser). Set HYPEN_BROWSER_PERF=1 to also time the
 * 14 MB componentize-js fixture (ts_counter_module.wasm).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..", "..");
const repoRoot = resolve(pkgDir, "..", "..", "..");
const fixturesDir = join(repoRoot, "hypen-engine-rs", "tests", "fixtures");
const outDir = join(pkgDir, "node_modules", ".cache", "module-host-browser");
const REQUIRED = process.env.HYPEN_BROWSER_TEST_REQUIRED === "1";
const PERF = process.env.HYPEN_BROWSER_PERF === "1";

function skip(why: string): never {
  const msg = `SKIP test:browser — ${why}`;
  if (REQUIRED) {
    console.error(`${msg} (HYPEN_BROWSER_TEST_REQUIRED=1, failing)`);
    process.exit(1);
  }
  console.log(msg);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Playwright (never installed by this script: playwright-core from the
// workspace, else a globally installed `playwright`).
// ---------------------------------------------------------------------------

type Pw = typeof import("playwright-core");
async function loadPlaywright(): Promise<Pw | null> {
  try {
    return (await import("playwright-core")) as Pw;
  } catch {
    try {
      return createRequire(join(process.cwd(), "noop.js"))("playwright") as Pw;
    } catch {
      return null;
    }
  }
}

if (!existsSync(join(pkgDir, "dist", "index.js"))) {
  console.error("dist/ is missing: run `bun run build` first (test:browser does).");
  process.exit(1);
}
if (!existsSync(join(fixturesDir, "counter_module.wasm"))) {
  skip(`component fixtures not found in ${fixturesDir}`);
}
const pw = await loadPlaywright();
if (!pw) skip("neither playwright-core nor playwright is resolvable");

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "app"), { recursive: true });
const build = await Bun.build({
  entrypoints: [join(here, "entry.ts")],
  outdir: join(outDir, "app"),
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  console.error("Bun.build of the browser entry failed");
  process.exit(1);
}
// What a consumer's bundler must do for jco-transpile: its component entry
// fetches `new URL('../vendor/js-component-bindgen-component.core*.wasm',
// import.meta.url)`. Bun (like esbuild) neither rewrites nor emits those, so
// the files go to `<bundle dir>/../vendor/`.
const jcoComponent = Bun.resolveSync("@bytecodealliance/jco-transpile/component", pkgDir);
const vendorSrc = resolve(dirname(jcoComponent), "..", "vendor");
mkdirSync(join(outDir, "vendor"));
const vendorWasm = readdirSync(vendorSrc).filter((f) => /^js-component-bindgen-component\.core\d*\.wasm$/.test(f));
for (const f of vendorWasm) cpSync(join(vendorSrc, f), join(outDir, "vendor", f));

const sizeOf = (bytes: Uint8Array) => ({ raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength });
const bundleJs = build.outputs.map((o) => readFileSync(o.path));
const jcoChunk = bundleJs.find((b) => b.includes("js-component-bindgen-component.core.wasm"));
const sizes = {
  js: bundleJs.reduce((a, b) => ({ raw: a.raw + sizeOf(b).raw, gzip: a.gzip + sizeOf(b).gzip }), { raw: 0, gzip: 0 }),
  jcoBindgenJs: jcoChunk ? sizeOf(jcoChunk) : { raw: 0, gzip: 0 },
  vendorWasm: vendorWasm
    .map((f) => sizeOf(readFileSync(join(outDir, "vendor", f))))
    .reduce((a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip }), { raw: 0, gzip: 0 }),
};

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const CSP: Record<string, string | null> = {
  none: null,
  recommended: "script-src 'self' 'wasm-unsafe-eval' blob:",
  strictRecommended: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:",
  dataOnly: "script-src 'self' 'wasm-unsafe-eval' data:",
  noBlobNoData: "script-src 'self' 'wasm-unsafe-eval'",
  noWasmEval: "script-src 'self' blob: data:",
  strict: "script-src 'self'",
  defaultSelf: "default-src 'self'",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const state = { vendorMissing: false, bytesSent: new Map<string, number>() };

function serveFile(req: Request, path: string): Response {
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const body = readFileSync(path);
  const headers: Record<string, string> = {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  let payload: Uint8Array = body;
  if ((req.headers.get("accept-encoding") ?? "").includes("gzip") && body.byteLength > 1024) {
    payload = gzipSync(body);
    headers["content-encoding"] = "gzip";
  }
  const p = new URL(req.url).pathname;
  state.bytesSent.set(p, (state.bytesSent.get(p) ?? 0) + payload.byteLength);
  return new Response(payload, { headers });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
      const csp = CSP[url.searchParams.get("csp") ?? "none"];
      const headers: Record<string, string> = {
        "content-type": MIME[".html"]!,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      if (csp) headers["content-security-policy"] = csp;
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>module-host</title>' +
          '<script type="module" src="/app/entry.js"></script>',
        { headers },
      );
    }
    if (p.startsWith("/app/") || p.startsWith("/vendor/")) {
      if (p.startsWith("/vendor/") && state.vendorMissing) return new Response("gone", { status: 404 });
      return serveFile(req, join(outDir, p.slice(1)));
    }
    if (p.startsWith("/fixtures/") && /^[\w.-]+\.wasm$/.test(p.slice(10))) {
      return serveFile(req, join(fixturesDir, p.slice(10)));
    }
    if (p === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  },
});

// The HTTP target (blocking wasi:http and deferred requests): another origin
// (port), so CORS applies.
const httpHits: string[] = [];
const HTTP_BODY = '{"greeting":"hello"}';
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    httpHits.push(`${req.method} ${path}`);
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "/moved") return new Response(null, { status: 302, headers: { ...cors, location: "/hello" } });
    if (path === "/missing") return new Response("no such thing", { status: 404, headers: { ...cors, "content-type": "text/plain" } });
    return new Response(HTTP_BODY, { headers: { ...cors, "content-type": "application/json" } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

let browser: import("playwright-core").Browser;
try {
  browser = await pw!.chromium.launch();
} catch (e) {
  server.stop(true);
  apiServer.stop(true);
  skip(`Chromium could not be launched: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
}

const failures: string[] = [];
const report: Record<string, unknown> = {};
const cspTable: { policy: string; outcome: string; detail: string }[] = [];

function check(cond: unknown, what: string): void {
  if (!cond) {
    failures.push(what);
    console.log(`  FAIL ${what}`);
  } else {
    console.log(`  ok   ${what}`);
  }
}

type Page = import("playwright-core").Page;
interface Ctx {
  page: Page;
  /** Console errors / page errors seen so far. */
  errors: string[];
  goto(csp?: string): Promise<void>;
  hx<T>(fn: string, ...args: unknown[]): Promise<T>;
}

async function scenario(
  name: string,
  body: (ctx: Ctx) => Promise<void>,
  expectedErrors: RegExp[] = [],
): Promise<void> {
  console.log(`\n# ${name}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const ctx: Ctx = {
    page,
    errors,
    async goto(csp = "none") {
      await page.goto(`${origin}/?csp=${csp}`);
      await page.waitForFunction(() => (globalThis as { hxReady?: boolean }).hxReady === true, null, {
        timeout: 20_000,
      });
    },
    hx<T>(fn: string, ...args: unknown[]) {
      return page.evaluate(
        ([f, a]) => ((globalThis as any).hx[f as string] as (...x: unknown[]) => unknown)(...(a as unknown[])),
        [fn, args] as const,
      ) as Promise<T>;
    },
  };
  try {
    await body(ctx);
  } catch (e) {
    check(false, `${name}: threw ${String((e as Error)?.stack ?? e)}`);
  }
  const unexpected = errors.filter((e) => !expectedErrors.some((re) => re.test(e)));
  check(unexpected.length === 0, `${name}: no unexpected console/page errors${unexpected.length ? `\n       ${unexpected.join("\n       ")}` : ""}`);
  await context.close();
}

type PrepareResult =
  | { ok: true; info: import("../../src/index.ts").PrepareInfo; wallMs: number }
  | { ok: false; error: string; wallMs: number };

const COUNTER = "counter_module.wasm";
const counterManifest = { name: "counter", version: "1.0.0", storage: ["local", "cloud"], reads: [], dispatches: [], http: false };
const count = (s: string) => JSON.parse(s).count as number;
const inc = { action: "increment" };

const CSP_VIOLATION = /violates the following Content Security Policy directive/;

// ---------------------------------------------------------------------------
// (a)(b)(c)(d) under the recommended policy
// ---------------------------------------------------------------------------

await scenario("transpile + Blob URL load + dispatch round-trip (CSP: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:)", async (c) => {
  await c.goto("strictRecommended");
  const backend = await c.hx<string>("newHost", "h");
  check(backend === "LocalStorageBackend", `default backend in a page is LocalStorageBackend (got ${backend})`);

  const cold = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, counterManifest);
  check(cold.ok, `(a) prepare(counter_module.wasm) succeeds${cold.ok ? "" : `: ${cold.error}`}`);
  if (!cold.ok) return;
  check(cold.info.loadedVia === "blob", `(a) bindings loaded via Blob URL (got ${cold.info.loadedVia})`);
  report.counterColdPrepare = { wallMs: cold.wallMs, ...cold.info };

  const run = await c.hx<{ actions: string[]; states: string[]; effects: { tag: string }[] }>("run", "h", "counter", [inc, inc, inc]);
  check(run.actions.includes("increment") && run.actions.includes("sync"), `(b) actions() = ${run.actions.join(",")}`);
  check(run.states.map(count).join(",") === "0,1,2,3", `(b) init + 3 increments -> counts ${run.states.map(count).join(",")}`);
  check(run.effects.filter((e) => e.tag === "log").length === 3, "(b) each increment emitted a log effect");

  const sync = await c.hx<{ states: string[] }>("run", "h", "counter", [{ action: "sync" }]);
  check(sync.states.length === 2, "(b) cloud compare-and-set path (sync) runs");
  const dump = await c.hx<Record<string, { version?: number }>>("dump", "h");
  check(Object.keys(dump).some((k) => k.startsWith("cloud/")), "(b) sync wrote to cloud with a version");

  // A second, warm prepare in the same page: jco's bindgen is already compiled.
  const warm = await c.hx<PrepareResult>("prepare", "h", "counter2", COUNTER, { ...counterManifest, name: "counter2" });
  check(warm.ok && warm.info.loadedVia === "blob", "(a) a second prepare() in the same page also uses Blob URL");
  if (warm.ok) report.counterWarmPrepare = { wallMs: warm.wallMs, ...warm.info };
});

await scenario("local storage persists across a reload through real localStorage, module-private", async (c) => {
  await c.goto("recommended");
  await c.hx("newHost", "h");
  let r = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, counterManifest);
  check(r.ok, "prepare before reload");
  const before = await c.hx<{ states: string[] }>("run", "h", "counter", [inc, inc, inc, inc]);
  check(count(before.states.at(-1)!) === 4, "4 increments before reload");
  const keys = await c.hx<string[]>("localStorageKeys");
  check(keys.length > 0 && keys.every((k) => k.startsWith("hypen-storage:v1/")), `(c) ${keys.length} localStorage keys, all under hypen-storage:v1/`);

  await c.page.reload();
  await c.page.waitForFunction(() => (globalThis as { hxReady?: boolean }).hxReady === true);
  await c.hx("newHost", "h");
  r = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, counterManifest);
  check(r.ok, "prepare after reload");
  const after = await c.hx<{ states: string[] }>("run", "h", "counter", []);
  check(count(after.states[0]!) === 4, `(c) warm init after reload reads count 4 back (got ${after.states[0]})`);

  // Module-private: the same component under another registered name sees nothing...
  r = await c.hx<PrepareResult>("prepare", "h", "spy", COUNTER, { ...counterManifest, name: "spy" });
  const spy = await c.hx<{ states: string[] }>("run", "h", "spy", []);
  check(count(spy.states[0]!) === 0, `(c) a second module ('spy') starts at 0, cannot see counter's local data`);
  // ...and spy's storage imports cannot reach counter's buckets either.
  const probe = await c.hx<{ tried: number; leaked: string[] }>("spyOnLocal", "h", "counter", "spy");
  check(probe.tried > 0 && probe.leaked.length === 0, `(c) spy probed ${probe.tried} of counter's local entries, leaked ${probe.leaked.length}`);
});

await scenario("link-time denial of an ungranted storage scope", async (c) => {
  await c.goto("recommended");
  await c.hx("newHost", "h", "memory");
  const r = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, { ...counterManifest, storage: ["local"] });
  check(!r.ok, "(d) prepare() fails without the cloud grant");
  if (!r.ok) {
    report.linkDenialError = r.error;
    check(/storage scope denied for module 'counter'.*hypen:storage\/cloud.*'cloud'/.test(r.error), `(d) error names the interface and grant: ${r.error}`);
  }
});

await scenario("localStorage capacity: host quota vs the browser's own quota", async (c) => {
  await c.goto("recommended");
  type Fill = { valueBytes: number; error: { tag: string; val: string } | null; localStorageChars: number };
  // The host's partition quota answers in the browser with the native
  // payload: 4 × (262144 + "persistent/4:fillkN" = 19) - 1 MiB = 76 bytes over.
  await c.hx("newHost", "small", "default", { maxPartitionBytes: 1024 * 1024 });
  const small = await c.hx<Fill>("fill", "small", 256 * 1024);
  check(
    small.valueBytes === 3 * 256 * 1024 && small.error?.tag === "quota-exceeded" && small.error.val === "76",
    `1 MiB partition: 3 × 256 KiB stored, then ${JSON.stringify(small.error)} (native payload: 76 bytes over)`,
  );
  // With the default 5 MiB budget the BROWSER's localStorage quota (per
  // origin, shared by every module and scope) runs out first: values are
  // base64-encoded (×4/3) into UTF-16 strings. It surfaces as the WIT
  // backend error, not quota-exceeded.
  await c.hx("newHost", "h");
  const dflt = await c.hx<Fill>("fill", "h", 256 * 1024);
  report.localStorageBrowserQuota = dflt;
  check(
    dflt.error?.tag === "backend" && /QuotaExceeded/i.test(String(dflt.error.val)) && dflt.valueBytes < 5 * 1024 * 1024,
    `default quotas: browser quota hit after ${(dflt.valueBytes / 1048576).toFixed(2)} MiB of values ` +
      `(${dflt.localStorageChars} chars in localStorage): ${dflt.error?.tag}(${String(dflt.error?.val).slice(0, 40)}…)`,
  );
});

// ---------------------------------------------------------------------------
// (e) CSP truth table
// ---------------------------------------------------------------------------

interface CspCase {
  csp: keyof typeof CSP;
  expect: "blob" | "data" | RegExp;
  errors: RegExp[];
  maxViolations?: number;
}
const cspCases: CspCase[] = [
  { csp: "none", expect: "blob", errors: [] },
  { csp: "recommended", expect: "blob", errors: [] },
  { csp: "strictRecommended", expect: "blob", errors: [] },
  // blob: blocked -> data: fallback; ONE violation per page (the loader remembers).
  { csp: "dataOnly", expect: "data", errors: [CSP_VIOLATION], maxViolations: 1 },
  { csp: "noBlobNoData", expect: /Content-Security-Policy blocked both blob: and data: module scripts.*Add `blob:` \(preferred\) or `data:` to script-src/, errors: [CSP_VIOLATION] },
  { csp: "noWasmEval", expect: /blocks WebAssembly compilation\. Add 'wasm-unsafe-eval' to script-src/, errors: [] },
  { csp: "strict", expect: /blocks WebAssembly compilation\. Add 'wasm-unsafe-eval' to script-src.*also add blob: \(or data:\)/, errors: [] },
  { csp: "defaultSelf", expect: /\(default-src 'self'\) blocks WebAssembly compilation\. Add 'wasm-unsafe-eval'.*also add blob:/, errors: [] },
];

for (const tc of cspCases) {
  const policy = CSP[tc.csp] ?? "(no CSP)";
  await scenario(
    `(e) CSP ${policy}`,
    async (c) => {
      await c.goto(tc.csp);
      await c.hx("newHost", "h", "memory");
      const r = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, counterManifest);
      if (typeof tc.expect === "string") {
        check(r.ok, `works${r.ok ? "" : `: ${r.error}`}`);
        if (!r.ok) return cspTable.push({ policy, outcome: "FAILS (unexpected)", detail: r.error });
        check(r.info.loadedVia === tc.expect, `loaded via ${r.info.loadedVia} (expected ${tc.expect})`);
        const run = await c.hx<{ states: string[] }>("run", "h", "counter", [inc]);
        check(count(run.states.at(-1)!) === 1, "dispatch works");
        // A second module on the same page must not add another violation.
        const r2 = await c.hx<PrepareResult>("prepare", "h", "counter2", COUNTER, { ...counterManifest, name: "counter2" });
        check(r2.ok && r2.info.loadedVia === tc.expect, `second prepare also via ${tc.expect}`);
        const violations = c.errors.filter((e) => CSP_VIOLATION.test(e)).length;
        if (tc.maxViolations !== undefined) {
          check(violations <= tc.maxViolations, `${violations} CSP violation(s) for two prepares (max ${tc.maxViolations})`);
        }
        cspTable.push({
          policy,
          outcome: r.info.loadedVia === "blob" ? "works (blob:)" : "works via data: fallback",
          detail: violations ? `${violations} console CSP violation report (the blob: attempt)` : "",
        });
      } else {
        check(!r.ok, "prepare() fails");
        if (r.ok) return cspTable.push({ policy, outcome: "WORKS (unexpected)", detail: "" });
        check(tc.expect.test(r.error), `error is actionable: ${r.error}`);
        cspTable.push({ policy, outcome: "fails", detail: r.error });
      }
    },
    tc.errors,
  );
}

// jco's own wasm not served -> the error points at the bundling step.
await scenario("jco vendor wasm missing (bundler did not copy it)", async (c) => {
  await c.goto("none");
  await c.hx("newHost", "h", "memory");
  state.vendorMissing = true;
  try {
    const r = await c.hx<PrepareResult>("prepare", "h", "counter", COUNTER, counterManifest);
    check(!r.ok, "prepare() fails");
    if (!r.ok) {
      report.vendorMissingError = r.error;
      check(/js-component-bindgen-component\.core\*\.wasm/.test(r.error) && /README/.test(r.error), `error names the missing jco assets: ${r.error}`);
    }
  } finally {
    state.vendorMissing = false;
  }
}, [/Failed to load resource: the server responded with a status of 404/]);

// ---------------------------------------------------------------------------
// (f) wasi:http
// ---------------------------------------------------------------------------

const FETCHER = "fetcher_module.wasm";
const fetcherManifest = { name: "fetcher", version: "1.0.0", reads: [], dispatches: [] };

await scenario("(f) wasi:http denied: prepare() fails naming the imports", async (c) => {
  await c.goto("recommended");
  await c.hx("newHost", "h", "memory");
  for (const http of [false, undefined]) {
    const r = await c.hx<PrepareResult>("prepare", "h", "fetcher", FETCHER, http === undefined ? fetcherManifest : { ...fetcherManifest, http });
    check(!r.ok && /http egress denied for module 'fetcher'.*wasi:http\/outgoing-handler/.test(r.error), `http: ${http} -> ${r.ok ? "prepared" : r.error}`);
  }
});

await scenario("(f) wasi:http granted: cross-origin fetch with CORS", async (c) => {
  await c.goto("recommended");
  await c.hx("newHost", "h", "memory");
  const r = await c.hx<PrepareResult>("prepare", "h", "fetcher", FETCHER, { ...fetcherManifest, http: true });
  check(r.ok, `prepare with http: true${r.ok ? "" : `: ${r.error}`}`);
  if (!r.ok) return;
  httpHits.length = 0;
  const url = `http://127.0.0.1:${apiServer.port}/hello`;
  // The browser shim can only answer wasi:io/poll asynchronously; a reducer
  // that blocks on a response cannot complete synchronously. Bound the call.
  const result = await Promise.race([
    c.hx<{ states: string[] } | { error: string }>("run", "h", "fetcher", [{ action: "fetch", payload: { url } }]).catch(
      (e: Error) => ({ error: e.message }),
    ),
    new Promise<{ error: string }>((res) => setTimeout(() => res({ error: "TIMEOUT: dispatch did not return within 15 s" }), 15_000)),
  ]);
  await new Promise((r) => setTimeout(r, 500));
  report.httpGranted = { result, serverHits: [...httpHits] };
  // Verified behaviour: the request really egresses (CORS-permitted, the
  // server sees it) but the synchronous reducer cannot receive the response
  // in a browser, so the module traps and the host explains why.
  check(httpHits.includes("GET /hello"), `granted: the request reached the cross-origin server (hits: ${httpHits.join(", ") || "none"})`);
  if ("states" in result) {
    const s = JSON.parse(result.states.at(-1)!);
    check(s.received?.status === 200 && s.received?.body === HTTP_BODY, `granted fetch landed the body in state: ${result.states.at(-1)}`);
  } else {
    check(
      /module 'fetcher' trapped .*in a browser wasi:http cannot complete inside a synchronous reducer call/.test(result.error),
      `granted: the reducer cannot await the response; the error explains it: ${result.error.split("\n")[0]}`,
    );
  }
  // The guest's own panic, printed on its stderr (wasi:cli/stderr -> console.error).
}, [/^console: $/, /panicked at .*waki/, /^console: incoming response available$/, /RUST_BACKTRACE/]);

// ---------------------------------------------------------------------------
// (g) deferred HTTP (hypen:http/deferred): the supported way to do HTTP in a
//     browser. The reducer only queues; the page performs the request and
//     dispatches the completion — nothing blocks, nothing traps.
// ---------------------------------------------------------------------------

const DEFERRED = "deferred_http_module.wasm";
const deferredManifest = { name: "net", version: "1.0.0", reads: [], dispatches: [] };

if (existsSync(join(fixturesDir, DEFERRED))) {
  type Deferred = {
    afterQueue: string;
    performed: { method: string; url: string; then: string; tag: string | null; outcome: string }[];
    state: string;
  };

  await scenario("(g) hypen:http/deferred denied: prepare() fails naming the import", async (c) => {
    await c.goto("recommended");
    await c.hx("newHost", "h", "memory");
    for (const http of [false, undefined]) {
      const r = await c.hx<PrepareResult>("prepare", "h", "net", DEFERRED, http === undefined ? deferredManifest : { ...deferredManifest, http });
      check(
        !r.ok && /http egress denied for module 'net'.*hypen:http\/deferred/.test(r.error),
        `http: ${http} -> ${r.ok ? "prepared" : r.error}`,
      );
    }
  });

  await scenario("(g) hypen:http/deferred granted: `get` queues, the page fetches, `fetched` receives the completion", async (c) => {
    await c.goto("recommended");
    await c.hx("newHost", "h", "memory");
    const allowed = `127.0.0.1:${apiServer.port}`;
    const r = await c.hx<PrepareResult>("prepare", "h", "net", DEFERRED, { ...deferredManifest, http: true, httpHosts: [allowed] });
    check(r.ok, `prepare with http: true, httpHosts: ["${allowed}"]${r.ok ? "" : `: ${r.error}`}`);
    if (!r.ok) return;
    if (r.ok) report.deferredHttpPrepare = { wallMs: r.wallMs, ...r.info };

    httpHits.length = 0;
    const url = `http://${allowed}/hello`;
    const ok = await c.hx<Deferred>("deferredHttp", "h", "net", "get", { url, tag: "page" });
    const queued = JSON.parse(ok.afterQueue);
    check(queued.queued === 1 && queued.completions === 0 && queued.sendError === null, `the reducer returned with the request queued, nothing completed: ${ok.afterQueue}`);
    check(
      ok.performed.length === 1 && ok.performed[0]!.url === url && ok.performed[0]!.then === "fetched" && ok.performed[0]!.outcome === "status 200",
      `the page performed it: ${JSON.stringify(ok.performed)}`,
    );
    check(httpHits.includes("GET /hello"), `the request reached the cross-origin server (hits: ${httpHits.join(", ") || "none"})`);
    const done = JSON.parse(ok.state);
    check(
      done.completions === 1 &&
        done.last?.ok === true &&
        done.last.status === 200 &&
        done.last.body === HTTP_BODY &&
        done.last.bodyEncoding === "utf8" &&
        done.last.contentType === "application/json" &&
        done.last.tag === "page",
      `the completion landed in module state: ${JSON.stringify(done.last)}`,
    );
    report.deferredHttp = { performed: ok.performed, last: done.last };

    // A non-2xx status is a completed exchange, not a failure.
    const missing = await c.hx<Deferred>("deferredHttp", "h", "net", "get", { url: `http://${allowed}/missing` });
    const missed = JSON.parse(missing.state).last;
    check(missed?.ok === true && missed.status === 404 && missed.body === "no such thing", `a 404 arrives as ok: true with its status: ${JSON.stringify(missed)}`);

    // Chained: the completion handler queues the next request.
    const chained = await c.hx<Deferred>("deferredHttp", "h", "net", "get", { url, tag: "first", next: `http://${allowed}/missing` });
    const log = JSON.parse(chained.state).log;
    check(JSON.stringify(log) === JSON.stringify(['"first":200', '"chained":404']), `a completion can queue the next request: ${JSON.stringify(log)}`);

    // The allowlist answers at `send`, in the page, with the native wording.
    const refused = await c.hx<Deferred>("deferredHttp", "h", "net", "get", { url: "https://evil.test/" });
    check(refused.performed.length === 0, "a host outside httpHosts is not queued, so nothing is fetched");
    check(
      JSON.parse(refused.state).sendError === "permission-denied: host 'evil.test:443' is not in the manifest's `httpHosts` allowlist",
      `the guest is told why: ${JSON.parse(refused.state).sendError}`,
    );

    // A browser embedder cannot check a redirect's target before following
    // it, so the harness refuses redirects: the module sees a failure.
    const moved = await c.hx<Deferred>("deferredHttp", "h", "net", "get", { url: `http://${allowed}/moved`, tag: "moved" });
    const movedLast = JSON.parse(moved.state).last;
    check(movedLast?.ok === false && movedLast.error === "network" && movedLast.tag === "moved", `a redirect is refused by the page (redirect: "error") and completes as a failure: ${JSON.stringify(movedLast)}`);
    // Chromium logs the 404s it was asked to fetch and the refused
    // redirect; nothing else may be logged.
  }, [
    /^console: Failed to load resource: net::ERR_FAILED$/,
    /^console: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
  ]);
}

// ---------------------------------------------------------------------------
// Performance: the 14 MB componentize-js module (opt-in, slow)
// ---------------------------------------------------------------------------

if (PERF && existsSync(join(fixturesDir, "ts_counter_module.wasm"))) {
  for (const [label, file, name] of [
    ["ts_counter_module.wasm (componentize-js, 14 MB)", "ts_counter_module.wasm", "ts_counter"],
    ["go_counter_module.wasm (TinyGo, 1 MB)", "go_counter_module.wasm", "go_counter"],
  ] as const) {
    await scenario(`perf: first prepare() of ${label}`, async (c) => {
      await c.goto("recommended");
      await c.hx("newHost", "h", "memory");
      const grants = name === "ts_counter" ? { storage: ["local", "app", "cloud"], http: true } : {};
      const r = await c.hx<PrepareResult>("prepare", "h", name, file, { name, ...grants });
      check(r.ok, `prepare${r.ok ? "" : `: ${r.error}`}`);
      if (!r.ok) return;
      report[`${name}ColdPrepare`] = { wallMs: r.wallMs, ...r.info };
      const run = await c.hx<{ states: string[] }>("run", "h", name, [inc, inc]);
      check(count(run.states.at(-1)!) === 2, `init + 2 increments -> ${run.states.at(-1)}`);
    });
  }
}

await browser.close();
server.stop(true);
apiServer.stop(true);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
console.log("\n## Sizes (Bun.build --minify, splitting; gzip -6)");
console.log(`  bundle JS (host + preview2-shim + jco bindgen glue + test entry): ${kb(sizes.js.raw)} raw, ${kb(sizes.js.gzip)} gzip`);
console.log(`    of which jco bindgen JS chunk: ${kb(sizes.jcoBindgenJs.raw)} raw, ${kb(sizes.jcoBindgenJs.gzip)} gzip`);
console.log(`  jco vendor wasm (${vendorWasm.length} files): ${kb(sizes.vendorWasm.raw)} raw, ${kb(sizes.vendorWasm.gzip)} gzip`);
const sent = [...state.bytesSent].filter(([p]) => p.startsWith("/app/") || p.startsWith("/vendor/"));
console.log(`  bytes served for /app + /vendor over the whole run: ${kb(sent.reduce((a, [, n]) => a + n, 0))}`);

console.log("\n## Timings (Chromium, first prepare() in a fresh page)");
for (const [k, v] of Object.entries(report)) {
  if (!k.endsWith("Prepare")) continue;
  const i = v as { wallMs: number; componentBytes: number; timings: Record<string, number> };
  const t = Object.entries(i.timings).map(([n, ms]) => `${n}=${ms.toFixed(0)}`).join(" ");
  console.log(`  ${k}: ${kb(i.componentBytes)} component, wall ${i.wallMs.toFixed(0)} ms (${t})`);
}

console.log("\n## CSP truth table");
for (const row of cspTable) console.log(`  ${row.policy.padEnd(66)} ${row.outcome}${row.detail ? `\n      ${row.detail}` : ""}`);

for (const k of ["localStorageBrowserQuota"]) {
  if (report[k]) console.log(`\n## ${k}\n  ${JSON.stringify(report[k])}`);
}
if (report.httpGranted) console.log(`\n## wasi:http granted\n  ${JSON.stringify(report.httpGranted)}`);
if (report.deferredHttp) console.log(`\n## hypen:http/deferred granted\n  ${JSON.stringify(report.deferredHttp)}`);

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(`  - ${f.split("\n")[0]}`);
  process.exit(1);
}
console.log("\nPASS: all browser checks passed");
