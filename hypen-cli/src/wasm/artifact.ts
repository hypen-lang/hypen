/**
 * Checking what a toolchain produced. An exit code of 0 is not evidence of a
 * usable artifact: a mis-resolved tool can write nothing, a truncated write
 * leaves an empty file, and a toolchain older than its component support
 * emits a *core* module — which `hypen-runtime` rejects at load time with an
 * error that no longer points at the build.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { BuildError } from "../build-error.js";
import type { ModuleName } from "./types.js";

/** What the first eight bytes of a file say it is. */
export type WasmKind =
  | { kind: "component" }
  /** A core WebAssembly module: valid wasm, but not a Component. */
  | { kind: "core-module" }
  | { kind: "empty" }
  | { kind: "not-wasm" };

/**
 * Classify a binary by its preamble. Both formats start with `\0asm`; the
 * next four bytes are `version: u16` + `layer: u16` (little-endian). Core
 * modules are version 1 / layer 0; components are layer 1 (version 0x0d
 * today, and expected to change at 1.0 — hence the check on the layer only).
 */
export function classifyWasm(header: Uint8Array): WasmKind {
  if (header.length === 0) return { kind: "empty" };
  const magic = [0x00, 0x61, 0x73, 0x6d];
  if (header.length < 8 || magic.some((b, i) => header[i] !== b)) return { kind: "not-wasm" };
  const layer = (header[6] ?? 0) | ((header[7] ?? 0) << 8);
  return layer === 1 ? { kind: "component" } : { kind: "core-module" };
}

function readHeader(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Assert that `tool` wrote a WebAssembly Component at `wasmPath`.
 *
 * @throws {BuildError} `TOOL_NO_OUTPUT` when nothing was written,
 *   `ARTIFACT_INVALID` when what was written is not a component.
 */
export function assertComponent(
  wasmPath: string,
  module: ModuleName,
  tool: string,
  hints: { noOutput: string; notComponent: string }
): void {
  if (!existsSync(wasmPath) || !statSync(wasmPath).isFile()) {
    throw new BuildError(`${tool} reported success but did not write ${wasmPath}.`, {
      code: "TOOL_NO_OUTPUT",
      module,
      file: wasmPath,
      hint: hints.noOutput,
    });
  }
  const found = classifyWasm(readHeader(wasmPath));
  if (found.kind === "component") return;
  const what =
    found.kind === "empty"
      ? "an empty file"
      : found.kind === "core-module"
        ? "a core WebAssembly module, not a Component"
        : "not a WebAssembly binary";
  throw new BuildError(`${tool} produced ${what} for ${module} (${wasmPath}).`, {
    code: "ARTIFACT_INVALID",
    module,
    file: wasmPath,
    hint: hints.notComponent,
  });
}
