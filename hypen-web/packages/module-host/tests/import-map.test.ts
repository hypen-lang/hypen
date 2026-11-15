/**
 * Unit tests for the per-module import-map builder — the browser-style
 * link-time capability gate (shim withholding for wasi:http and
 * hypen:storage/{app,cloud}), with deny-by-default manifests.
 */

import { describe, expect, test } from "bun:test";
import { buildImportMap, normalizeManifest } from "../src/index.ts";

// Stand-in implementations: buildImportMap only filters by key.
const available: Record<string, unknown> = Object.fromEntries(
  [
    "hypen:storage/local",
    "hypen:storage/app",
    "hypen:storage/cloud",
    "hypen:engine/state",
    "wasi:io/streams",
    "wasi:cli/stdout",
    "wasi:http/types",
    "wasi:http/outgoing-handler",
  ].map((k) => [k, { impl: k }]),
);

const HTTP = ["wasi:http/types@0.2.3", "wasi:http/outgoing-handler@0.2.3"];

describe("buildImportMap http gate", () => {
  test("absent manifest denies http (deny-by-default)", () => {
    expect(() => buildImportMap("m", undefined, HTTP, available)).toThrow(/http egress denied/);
  });

  test("manifest without the http field denies http", () => {
    expect(() => buildImportMap("m", { storage: [] }, HTTP, available)).toThrow(/http egress denied/);
  });

  test("http: true grants the wasi:http shims", () => {
    const map = buildImportMap("m", { http: true }, HTTP, available);
    expect("wasi:http/types" in map).toBe(true);
    expect("wasi:http/outgoing-handler" in map).toBe(true);
  });

  test("truthy non-boolean http is not a grant", () => {
    expect(() => buildImportMap("m", { http: "yes" as unknown as boolean }, HTTP, available)).toThrow(
      /http egress denied/,
    );
  });

  test("http: false withholds the shims and names the missing imports", () => {
    expect(() =>
      buildImportMap("m", { http: false }, [
        "wasi:http/outgoing-handler@0.2.3",
        "wasi:http/types@0.2.3",
      ], available),
    ).toThrow(/http egress denied for module 'm'.*wasi:http\/outgoing-handler, wasi:http\/types/);
  });

  test("http: false is fine for a component that never imports wasi:http", () => {
    const map = buildImportMap("m", { http: false }, ["wasi:io/streams", "hypen:storage/local"], available);
    expect("wasi:http/types" in map).toBe(false);
    expect("wasi:http/outgoing-handler" in map).toBe(false);
    expect("hypen:storage/local" in map).toBe(true);
  });

  test("version suffixes are stripped before matching", () => {
    const map = buildImportMap("m", undefined, ["wasi:io/streams@0.2.9"], available);
    expect("wasi:io/streams" in map).toBe(true);
  });

  test("an unprovidable non-http import fails with a clear error", () => {
    expect(() => buildImportMap("m", undefined, ["wasi:sockets/tcp@0.2.3"], available)).toThrow(
      /does not provide: wasi:sockets\/tcp/,
    );
  });
});

describe("buildImportMap storage gate", () => {
  test("local and engine state are always linked", () => {
    const map = buildImportMap("m", undefined, ["hypen:storage/local@0.1.0", "hypen:engine/state"], available);
    expect(map["hypen:storage/local"]).toBe(available["hypen:storage/local"]);
    expect("hypen:engine/state" in map).toBe(true);
    expect("hypen:storage/app" in map).toBe(false);
    expect("hypen:storage/cloud" in map).toBe(false);
  });

  test("ungranted app/cloud imports fail at link time, naming the scopes", () => {
    expect(() =>
      buildImportMap("m", { storage: ["local"] }, ["hypen:storage/app@0.1.0", "hypen:storage/cloud@0.1.0"], available),
    ).toThrow(/storage scope denied for module 'm'.*hypen:storage\/app, hypen:storage\/cloud.*'app', 'cloud'/);
  });

  test("granted scopes are linked individually", () => {
    const map = buildImportMap("m", { storage: ["cloud"] }, ["hypen:storage/cloud"], available);
    expect("hypen:storage/cloud" in map).toBe(true);
    expect("hypen:storage/app" in map).toBe(false);
    expect(() => buildImportMap("m", { storage: ["cloud"] }, ["hypen:storage/app"], available)).toThrow(
      /'app'/,
    );
  });
});

describe("normalizeManifest", () => {
  test("defaults are deny-by-default", () => {
    const m = normalizeManifest(undefined);
    expect([...m.storage]).toEqual(["local"]);
    expect(m.reads.size).toBe(0);
    expect(m.dispatches.size).toBe(0);
    expect(m.http).toBe(false);
  });

  test("unknown scopes and non-string entries are dropped", () => {
    const m = normalizeManifest({
      storage: ["app", "disk", 3 as unknown as string],
      reads: ["a", null as unknown as string],
    });
    expect([...m.storage].sort()).toEqual(["app", "local"]);
    expect([...m.reads]).toEqual(["a"]);
  });
});
