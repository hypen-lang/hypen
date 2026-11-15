/**
 * Unit tests for the loader's browser-facing behaviour that can run under
 * Bun: which path loaded the bindings, and the CSP error translation (the
 * messages are the ones Chromium produces, as observed by the real-browser
 * harness in tests/browser/run.ts).
 */

import { describe, expect, test } from "bun:test";
import { importInMemoryModule, resetLoaderCache, wasmCspError } from "../src/loader.ts";
import { emptyFilesystem } from "../src/wasi.ts";

const chromiumWasmCsp = (directive: string) =>
  new WebAssembly.CompileError(
    "WebAssembly.compileStreaming(): Compiling or instantiating WebAssembly module violates the following " +
      "Content Security policy directive because 'unsafe-eval' is not an allowed source of script in the " +
      `following Content Security Policy directive: "${directive}".`,
  );

describe("importInMemoryModule", () => {
  test("reports the Blob URL path where blob: imports work (Bun)", async () => {
    resetLoaderCache();
    const { module, via } = await importInMemoryModule(new TextEncoder().encode("export const x = 42;"));
    expect(module.x).toBe(42);
    expect(via).toBe("blob");
  });

  test("a module that fails to evaluate surfaces both attempts", async () => {
    resetLoaderCache();
    const err = await importInMemoryModule(new TextEncoder().encode("throw new Error('boom');")).catch((e) => e);
    expect(String(err?.message)).toMatch(/boom/);
  });
});

describe("wasmCspError", () => {
  test("names 'wasm-unsafe-eval' and the violated directive", () => {
    const e = wasmCspError(chromiumWasmCsp("script-src 'self' blob: data:"), "jco transpile failed for module 'm'")!;
    expect(e.message).toContain("jco transpile failed for module 'm'");
    expect(e.message).toContain("(script-src 'self' blob: data:) blocks WebAssembly compilation");
    expect(e.message).toContain("Add 'wasm-unsafe-eval' to script-src");
    expect(e.message).not.toContain("also add blob:");
  });

  test("also points out a missing blob:/data: source", () => {
    for (const directive of ["script-src 'self'", "default-src 'self'"]) {
      const e = wasmCspError(chromiumWasmCsp(directive), "x")!;
      expect(e.message).toContain(`(${directive})`);
      expect(e.message).toContain("also add blob: (or data:)");
    }
  });

  test("leaves unrelated errors alone", () => {
    expect(wasmCspError(new WebAssembly.CompileError("expected magic word 00 61 73 6d"), "x")).toBeUndefined();
    expect(wasmCspError(new TypeError("Failed to fetch"), "x")).toBeUndefined();
  });
});

describe("emptyFilesystem", () => {
  test("links wasi:filesystem with no preopened directories", () => {
    const fs = emptyFilesystem() as Record<string, Record<string, any>>;
    expect(fs["wasi:filesystem/preopens"]!.getDirectories()).toEqual([]);
    expect(typeof fs["wasi:filesystem/types"]!.Descriptor).toBe("function");
    expect(typeof fs["wasi:filesystem/types"]!.DirectoryEntryStream).toBe("function");
    expect(fs["wasi:filesystem/types"]!.filesystemErrorCode(new Error("x"))).toBeUndefined();
  });
});
