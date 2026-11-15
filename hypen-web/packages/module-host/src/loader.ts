// The two async steps of prepare() that touch tooling:
//   transpileComponent   jco bindgen, in memory (browser-portable)
//   importInMemoryModule load the emitted bindings JS without touching disk
//
// Both translate the browser's Content-Security-Policy failures into errors
// that name the directive to add: Chromium reports a CSP-blocked module
// import only as a generic "Failed to fetch dynamically imported module"
// TypeError, and a blocked WebAssembly compile as a CompileError mentioning
// 'unsafe-eval' (the source the CSP spec actually wants is
// 'wasm-unsafe-eval').

/** One emitted file: `[relative name, bytes]`. */
export type TranspiledFile = [string, Uint8Array];

export interface TranspileResult {
  files: TranspiledFile[];
  /** Interfaces the component imports (unversioned, e.g. `wasi:io/streams`). */
  imports: string[];
}

/** How {@link importInMemoryModule} loaded the bindings. */
export type LoadedVia = "blob" | "data";

/**
 * If `e` is the browser refusing to compile WebAssembly because of a CSP,
 * an Error naming the sources to add to `script-src`; otherwise undefined.
 *
 * Chromium's message quotes the violated directive
 * (`… directive: "script-src 'self'"`), which is parsed to also point out a
 * missing `blob:`/`data:` — the very next step of `prepare()` needs one.
 */
export function wasmCspError(e: unknown, what: string): Error | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/Content[- ]Security[- ]Policy/i.test(msg) || !/unsafe-eval|WebAssembly/i.test(msg)) {
    return undefined;
  }
  const directive = /directive:\s*"([^"]+)"/i.exec(msg)?.[1];
  const sources = directive?.trim().split(/\s+/).slice(1) ?? [];
  const missingModuleSource =
    directive !== undefined && !sources.includes("blob:") && !sources.includes("data:");
  return new Error(
    `${what}: the page's Content-Security-Policy${directive ? ` (${directive})` : ""} blocks ` +
      "WebAssembly compilation. Add 'wasm-unsafe-eval' to script-src (jco's transpiler and " +
      "every module's core wasm are compiled at runtime)" +
      (missingModuleSource
        ? "; the generated bindings are then imported from a blob: URL, so also add blob: (or data:)"
        : "") +
      `. Browser error: ${msg}`,
    { cause: e },
  );
}

/**
 * Run jco's bindgen over component bytes. Uses
 * `@bytecodealliance/jco-transpile/component` (the browser-portable entry:
 * no node:fs / child_process / binaryen / minifier in its import graph),
 * with `instantiation: async` so the output exports
 * `instantiate(getCoreModule, imports)` and fetches nothing itself.
 *
 * The bindgen tool is itself a WASM component: on first use jco fetches and
 * compiles its vendored `js-component-bindgen-component.core*.wasm` (~5.7 MB)
 * from URLs relative to its own module (`new URL('../vendor/…',
 * import.meta.url)`), so a bundler must serve those files (see README).
 */
export async function transpileComponent(name: string, bytes: Uint8Array): Promise<TranspileResult> {
  const jco = await import("@bytecodealliance/jco-transpile/component");
  try {
    // jco starts fetching + compiling its own vendored wasm when the module
    // is first imported; a failure here is about serving jco, not the module.
    await jco.$init;
  } catch (e) {
    throw (
      wasmCspError(e, `jco transpile failed for module '${name}'`) ??
      new Error(
        `jco transpile failed for module '${name}': jco's own bindgen wasm could not be loaded ` +
          `(${String((e as Error)?.message ?? e)}). The bundler must serve ` +
          "@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.core*.wasm at " +
          "'../vendor/' relative to the bundled jco-transpile chunk, with Content-Type " +
          "application/wasm — see the module-host README, \"Bundling\".",
        { cause: e },
      )
    );
  }
  try {
    const out = await jco.callBindgen(() =>
      jco.generate(bytes, {
        name,
        instantiation: { tag: "async" },
        noTypescript: true,
      }),
    );
    return { files: out.files, imports: out.imports };
  } catch (e) {
    const what = `jco transpile failed for module '${name}'`;
    const csp = wasmCspError(e, what);
    if (csp) throw csp;
    const payload = (e as { payload?: unknown })?.payload;
    throw new Error(`${what}: ${payload ?? (e as Error)?.message ?? e}`, { cause: e });
  }
}

// null = untested, true/false = whether this runtime can import() a blob: URL.
let blobImportWorks: boolean | null = null;

/** Test hook: forget what was learned about blob: imports. */
export function resetLoaderCache(): void {
  blobImportWorks = null;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

interface CspViolation {
  blockedURI: string;
  effectiveDirective: string;
  originalPolicy: string;
}

/**
 * Collect `securitypolicyviolation` events (browsers, including workers)
 * while `run` executes. The event is dispatched as a separate task, so after
 * a failure the caller yields once before reading the list.
 */
async function watchCsp<T>(run: (seen: CspViolation[]) => Promise<T>): Promise<T> {
  const seen: CspViolation[] = [];
  const target = globalThis as unknown as {
    addEventListener?: (t: string, h: (e: CspViolation) => void) => void;
    removeEventListener?: (t: string, h: (e: CspViolation) => void) => void;
  };
  const onViolation = (e: CspViolation) => {
    seen.push({
      blockedURI: String(e.blockedURI ?? ""),
      effectiveDirective: String(e.effectiveDirective ?? ""),
      originalPolicy: String(e.originalPolicy ?? ""),
    });
  };
  target.addEventListener?.("securitypolicyviolation", onViolation);
  try {
    return await run(seen);
  } finally {
    target.removeEventListener?.("securitypolicyviolation", onViolation);
  }
}

const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Import an in-memory ES module (the jco-emitted bindings).
 *
 * Prefers a Blob URL (`URL.createObjectURL`, revoked as soon as the import
 * settles) — under a Content-Security-Policy this needs `blob:` in
 * `script-src`. Falls back to a `data:` URL (needs `data:` in script-src)
 * where blob: imports are unsupported (Node's ESM loader) or blocked. Once a
 * blob: import has failed and the data: fallback worked, later calls go
 * straight to data: (so a CSP without `blob:` reports one violation per
 * page, not one per module).
 *
 * If both are blocked the error names the CSP directive to change.
 */
export async function importInMemoryModule(source: Uint8Array): Promise<{ module: any; via: LoadedVia }> {
  return watchCsp(async (violations) => {
    let blobError: unknown;
    if (
      blobImportWorks !== false &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      const url = URL.createObjectURL(new Blob([source as BlobPart], { type: "text/javascript" }));
      try {
        const module = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
        blobImportWorks = true;
        return { module, via: "blob" as const };
      } catch (e) {
        blobError = e;
        if ((e as { code?: string })?.code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
          blobImportWorks = false; // Node: never works, don't retry
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const dataUrl = `data:text/javascript;base64,${toBase64(source)}`;
    try {
      const module = await import(/* @vite-ignore */ /* webpackIgnore: true */ dataUrl);
      if (blobError !== undefined) blobImportWorks = false;
      return { module, via: "data" as const };
    } catch (e) {
      await nextTask(); // let queued securitypolicyviolation events land
      const blocked = violations.filter((v) => /^(blob|data)/.test(v.blockedURI));
      if (blocked.length > 0) {
        const v = blocked[0]!;
        throw new Error(
          "could not import the transpiled module bindings: the page's Content-Security-Policy " +
            `blocked both blob: and data: module scripts (directive ${v.effectiveDirective} of ` +
            `policy "${v.originalPolicy}"). Add \`blob:\` (preferred) or \`data:\` to script-src ` +
            "(and to script-src-elem if the policy sets it).",
          { cause: e },
        );
      }
      if (blobError === undefined) throw e;
      throw new Error(
        "could not import the transpiled module bindings from a blob: or data: URL " +
          `(blob: ${String((blobError as Error)?.message ?? blobError)}; data: ${String((e as Error)?.message ?? e)}). ` +
          "Under a Content-Security-Policy, script-src must allow `blob:` (preferred) or `data:`.",
        { cause: e },
      );
    }
  });
}
