import { describe, it, expect } from "bun:test";
import { BaseEngine } from "@hypen-space/core/engine-base";
import { validatePatches } from "@hypen-space/core";
import type { ComponentResolver, Patch } from "@hypen-space/core/types";

/**
 * #4 — diagnostics for the most common silent failure of a new integration:
 * a component that resolves to nothing renders as an opaque, renderer-dropped
 * node with no error (the "BottomNav vanished" bug). Two surfaces:
 *   - BaseEngine warns once per unresolved name and tracks them
 *     (getUnresolvedComponents) — the runtime signal.
 *   - validatePatches(patches, knownTypes) — the wire-level CI assertion.
 */

/**
 * BaseEngine over a fake wasm engine whose `setComponentResolver` captures the
 * (wrapped) callback so the test can invoke it the way the Rust engine would
 * when it hits a non-primitive element type.
 */
class FakeEngine extends BaseEngine {
  private resolverCb: ((name: string, ctx: string | null) => unknown) | null = null;

  async init(): Promise<void> {
    this.wasmEngine = {
      setComponentResolver: (cb: (name: string, ctx: string | null) => unknown) => {
        this.resolverCb = cb;
      },
    };
    this.initialized = true;
  }

  protected unwrapForWasm<T>(value: T): T {
    return value;
  }

  /** Simulate the engine consulting the resolver for a non-primitive name. */
  resolve(name: string): unknown {
    return this.resolverCb?.(name, null);
  }
}

async function makeEngine(resolver: ComponentResolver): Promise<FakeEngine> {
  const engine = new FakeEngine();
  await engine.init();
  engine.setComponentResolver(resolver);
  return engine;
}

describe("BaseEngine resolver-miss tracking", () => {
  it("records a name the resolver returns null for", async () => {
    const engine = await makeEngine(() => null);
    engine.resolve("BottomNav");
    expect(engine.getUnresolvedComponents()).toEqual(["BottomNav"]);
  });

  it("does not record names that resolve successfully", async () => {
    const engine = await makeEngine((name) => ({ source: 'Text("x")', path: name }));
    engine.resolve("Home");
    expect(engine.getUnresolvedComponents()).toEqual([]);
  });

  it("records each unique unresolved name once, however many times it misses", async () => {
    // The one-time warning and the tracking entry are gated by the SAME
    // `unresolvedComponents.has(name)` guard, so a name appearing exactly
    // once in getUnresolvedComponents() after repeated misses is the
    // observable proxy for "warned once". (We assert on the tracked set
    // rather than spying on the logger, which is brittle under bun's module
    // resolution.)
    const engine = await makeEngine(() => null);
    engine.resolve("BottomNav");
    engine.resolve("BottomNav");
    engine.resolve("BottomNav");
    engine.resolve("Sidebar");
    expect(engine.getUnresolvedComponents().sort()).toEqual(["BottomNav", "Sidebar"]);
  });

  it("still returns the resolved component to the engine when present", async () => {
    const engine = await makeEngine((name) => ({ source: "S", path: name }));
    expect(engine.resolve("Home")).toEqual({ source: "S", path: "Home" });
  });
});

describe("validatePatches", () => {
  const create = (id: string, elementType: string): Patch =>
    ({ type: "create", id, elementType }) as unknown as Patch;

  it("flags create patches whose elementType is not known", () => {
    const patches = [create("1", "Column"), create("2", "BottomNav")];
    const { unknownTypes } = validatePatches(patches, ["Column", "Row", "Text"]);
    expect(unknownTypes).toEqual(["BottomNav"]);
  });

  it("returns empty when every created type is known", () => {
    const patches = [create("1", "Column"), create("2", "Text")];
    expect(validatePatches(patches, new Set(["Column", "Text"])).unknownTypes).toEqual([]);
  });

  it("de-duplicates repeated unknown types", () => {
    const patches = [create("1", "Card"), create("2", "Card"), create("3", "Card")];
    expect(validatePatches(patches, []).unknownTypes).toEqual(["Card"]);
  });

  it("ignores non-create patches", () => {
    const patches = [
      { type: "setProp", id: "1", name: "x", value: 1 } as unknown as Patch,
      { type: "remove", id: "2" } as unknown as Patch,
    ];
    expect(validatePatches(patches, []).unknownTypes).toEqual([]);
  });

  it("accepts both an array and a Set for knownTypes", () => {
    const patches = [create("1", "Foo")];
    expect(validatePatches(patches, ["Foo"]).unknownTypes).toEqual([]);
    expect(validatePatches(patches, new Set(["Foo"])).unknownTypes).toEqual([]);
  });
});
