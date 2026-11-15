// The two async steps of prepare() that touch tooling:
//   transpileComponent   jco bindgen, in memory (browser-portable)
//   importInMemoryModule load the emitted bindings JS without touching disk

/** One emitted file: `[relative name, bytes]`. */
export type TranspiledFile = [string, Uint8Array];

export interface TranspileResult {
  files: TranspiledFile[];
  /** Interfaces the component imports (unversioned, e.g. `wasi:io/streams`). */
  imports: string[];
}

/**
 * Run jco's bindgen over component bytes. Uses
 * `@bytecodealliance/jco-transpile/component` (the browser-portable entry:
 * no node:fs / child_process / binaryen / minifier in its import graph),
 * with `instantiation: async` so the output exports
 * `instantiate(getCoreModule, imports)` and fetches nothing itself.
 */
export async function transpileComponent(name: string, bytes: Uint8Array): Promise<TranspileResult> {
  const { generate, callBindgen } = await import("@bytecodealliance/jco-transpile/component");
  try {
    const out = await callBindgen(() =>
      generate(bytes, {
        name,
        instantiation: { tag: "async" },
        noTypescript: true,
      }),
    );
    return { files: out.files, imports: out.imports };
  } catch (e) {
    const payload = (e as { payload?: unknown })?.payload;
    throw new Error(
      `jco transpile failed for module '${name}': ${payload ?? (e as Error)?.message ?? e}`,
      { cause: e },
    );
  }
}

// null = untested, true/false = whether this runtime can import() a blob: URL.
let blobImportWorks: boolean | null = null;

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Import an in-memory ES module (the jco-emitted bindings).
 *
 * Prefers a Blob URL (`URL.createObjectURL`, revoked as soon as the import
 * settles) — under a Content-Security-Policy this needs `blob:` in
 * `script-src`. Falls back to a `data:` URL (needs `data:` in script-src)
 * where blob: imports are unsupported (Node's ESM loader) or fail.
 */
export async function importInMemoryModule(source: Uint8Array): Promise<any> {
  let blobError: unknown;
  if (
    blobImportWorks !== false &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  ) {
    const url = URL.createObjectURL(new Blob([source as BlobPart], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
      blobImportWorks = true;
      return mod;
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
    return await import(/* @vite-ignore */ /* webpackIgnore: true */ dataUrl);
  } catch (e) {
    if (blobError === undefined) throw e;
    throw new Error(
      "could not import the transpiled module bindings from a blob: or data: URL " +
        "(a Content-Security-Policy must allow `blob:` (preferred) or `data:` in script-src)",
      { cause: e },
    );
  }
}
