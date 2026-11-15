/**
 * Unit tests for the per-module import-map builder — the browser-style
 * link-time capability gate (http egress = shim withholding).
 */

import { describe, expect, test } from "bun:test";
import { buildImportMap } from "../src/index.ts";

describe("buildImportMap http gate", () => {
  test("absent manifest grants http (back-compat)", () => {
    const map = buildImportMap("m", undefined, [
      "wasi:http/types@0.2.3",
      "wasi:http/outgoing-handler@0.2.3",
    ]);
    expect("wasi:http/types" in map).toBe(true);
    expect("wasi:http/outgoing-handler" in map).toBe(true);
  });

  test("http: true grants the wasi:http shims", () => {
    const map = buildImportMap("m", { http: true }, ["wasi:http/types"]);
    expect("wasi:http/types" in map).toBe(true);
  });

  test("http: false withholds the shims and names the missing imports", () => {
    expect(() =>
      buildImportMap("m", { http: false }, [
        "wasi:http/outgoing-handler@0.2.3",
        "wasi:http/types@0.2.3",
      ]),
    ).toThrow(/http egress denied for module 'm'.*wasi:http\/outgoing-handler, wasi:http\/types/);
  });

  test("http: false is fine for a component that never imports wasi:http", () => {
    const map = buildImportMap("m", { http: false }, ["wasi:io/streams", "hypen:storage/local"]);
    expect("wasi:http/types" in map).toBe(false);
    expect("wasi:http/outgoing-handler" in map).toBe(false);
    expect("hypen:storage/local" in map).toBe(true);
  });

  test("version suffixes are stripped before matching", () => {
    const map = buildImportMap("m", undefined, ["wasi:io/streams@0.2.9"]);
    expect("wasi:io/streams" in map).toBe(true);
  });

  test("an unproviable non-http import fails with a clear error", () => {
    expect(() => buildImportMap("m", undefined, ["wasi:sockets/tcp@0.2.3"])).toThrow(
      /does not provide: wasi:sockets\/tcp/,
    );
  });
});
