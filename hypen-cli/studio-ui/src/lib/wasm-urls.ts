/**
 * Locally-served WASM engine URLs for the in-browser preview.
 *
 * The studio server exposes the project's `wasm-browser/` files at
 * `/wasm/*` (see `src/index.tsx`). When available, the preview engines
 * init from there — version-matched with the project and reachable
 * offline — instead of `Engine.init()`'s unpkg `@latest` CDN default.
 *
 * Probed once per page (HEAD request) and cached; `null` means "not
 * served here, let the engine use its default".
 */

export interface WasmInitOptions {
  jsUrl: string;
  wasmUrl: string;
}

let cached: WasmInitOptions | null | undefined;

export async function localWasmInitOptions(): Promise<WasmInitOptions | null> {
  if (cached !== undefined) return cached;
  try {
    const res = await fetch("/wasm/hypen_engine.js", { method: "HEAD" });
    // Drain the (empty) body: Chromium reports an unconsumed fetch as an
    // aborted request (net::ERR_ABORTED) in the console/devtools.
    await res.text().catch(() => {});
    cached = res.ok
      ? { jsUrl: "/wasm/hypen_engine.js", wasmUrl: "/wasm/hypen_engine_bg.wasm" }
      : null;
  } catch {
    cached = null;
  }
  return cached;
}
