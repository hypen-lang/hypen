/**
 * examples/wasm-module, booted for real: `hypen dev` in the example
 * directory, a WebSocket client connected over the actual protocol, one
 * interaction in each direction between the TypeScript `Cart` module and the
 * Rust `Pricing` module.
 *
 * `Pricing` is a SOURCE PACKAGE of the app (hypen.json
 * `wasm.packages["./modules/pricing"]`, `"source": true`): `hypen dev`
 * builds the crate. So that the example — and this test — run without a
 * Rust toolchain, the app also names a committed `fallback` package
 * (`modules/pricing/prebuilt`, made by `hypen pack`). By default this test
 * takes that path (`HYPEN_NO_SOURCE_BUILD=1`: no toolchain is invoked);
 * with `HYPEN_WASM_E2E=1` it lets `hypen dev` build the crate with cargo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { classifyWasm, readModulePackage } from "../src/build-wasm";

const REPO = resolve(import.meta.dir, "..", "..");
const EXAMPLE = join(REPO, "examples", "wasm-module");
const FALLBACK = join(EXAMPLE, "modules", "pricing", "prebuilt");
const WASM = join(FALLBACK, "Pricing.wasm");
const E2E = process.env.HYPEN_WASM_E2E === "1";
const PORT = 19960;
const skip = !existsSync(WASM);

type Patch = Record<string, any>;

describe.skipIf(skip)("examples/wasm-module", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let output = "";

  beforeAll(async () => {
    proc = Bun.spawn({
      cmd: ["bun", join(REPO, "hypen-cli", "bin", "hypen.ts"), "dev", "--port", String(PORT)],
      cwd: EXAMPLE,
      env: {
        ...process.env,
        HYPEN_NO_ONBOARDING: "1",
        NO_COLOR: "1",
        ...(E2E ? {} : { HYPEN_NO_SOURCE_BUILD: "1" }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    void drain(proc.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + (E2E ? 280_000 : 60_000);
    for (;;) {
      try {
        if ((await fetch(`http://localhost:${PORT}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (proc.exitCode !== null || Date.now() > deadline) {
        throw new Error(`hypen dev did not come up:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 300_000);

  afterAll(() => {
    proc?.kill();
  });

  test("the committed fallback is a verified package with a small WebAssembly Component", () => {
    expect(classifyWasm(readFileSync(WASM).subarray(0, 8))).toEqual({ kind: "component" });
    expect(statSync(WASM).size).toBeLessThan(200 * 1024);
    // readModulePackage checks the component against the manifest's integrity.
    const pkg = readModulePackage(join(FALLBACK, "hypen-modules.json"));
    expect(pkg.manifest.exports).toEqual(["Pricing"]);
    expect({ ...pkg.modules[0]!.requests }).toEqual({ reads: ["Cart"], dispatches: ["Cart"], storage: [], http: false, httpHosts: [] });
  });

  test(E2E ? "hypen dev built the crate from source" : "without a toolchain run, hypen dev says it is using the fallback", () => {
    if (E2E) {
      expect(output).toContain("Building ./modules/pricing");
      expect(output).toContain("./modules/pricing (built from source): Pricing");
    } else {
      expect(output).toContain("using the prebuilt fallback ./modules/pricing/prebuilt");
      expect(output).toContain("./modules/pricing (prebuilt fallback): Pricing");
    }
  });

  test("Cart (TypeScript) and Pricing (Rust) interact in both directions", async () => {
    expect(output).toContain("Prebuilt:   Pricing");

    const socket = new WebSocket(`ws://localhost:${PORT}`);
    const patches: Patch[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "initialTree" || message.type === "patch") patches.push(...message.patches);
    });
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done());
      socket.addEventListener("error", () => fail(new Error("connect failed")));
    });
    socket.send(JSON.stringify({ type: "hello" }));

    const texts = (): string[] => {
      const byNode = new Map<string, string>();
      for (const p of patches) {
        if (p.type === "create" && typeof p.props?.["0"] === "string") byNode.set(p.id, p.props["0"]);
        if (p.type === "setProp" && typeof p.value === "string") byNode.set(p.id, p.value);
      }
      return [...byNode.values()];
    };
    const until = async (...expected: string[]) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const now = texts();
        if (expected.every((text) => now.includes(text))) return;
        if (Date.now() > deadline) {
          throw new Error(`expected ${JSON.stringify(expected)} in ${JSON.stringify(now)}\n${output}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const click = (label: string, action: string) => {
      const button = patches.find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === label);
      if (!button) throw new Error(`no button "${label}"`);
      socket.send(
        JSON.stringify({
          type: "dispatchAction",
          module: "App",
          action: "__hypen_dispatch",
          payload: { node: button.id, action, payload: {} },
        })
      );
    };

    try {
      // Both modules render in the entry's template.
      await until("Items: 0", "Subtotal: $0.00", "Total: $0.00", "Quotes requested: 0");

      // A TypeScript action; the Rust module follows it through its
      // subscription to cart.count, reading Cart's state under `reads`.
      click("Add coffee ($4.50)", "addCoffee");
      await until("Items: 1", "Subtotal: $4.50", "Total: $4.50", "Discount applied: 0%");

      // Rust -> TypeScript: crossing $50, Pricing dispatches `applyDiscount`
      // to Cart, which lands in Cart's ordinary onAction handler with a sender.
      click("Add grinder ($48.00)", "addGrinder");
      await until(
        "Items: 2",
        "Subtotal: $52.50",
        "Discount: 10%",
        "Total: $47.25",
        "Discount applied: 10%",
        '10% off, decided by the "pricing" module.'
      );

      // TypeScript -> Rust: context.getModule("pricing").dispatch("quote").
      click("Ask Pricing for a quote", "requestQuote");
      await until("Quotes requested: 1");

      // The Rust module's own button, through strict client-action admission.
      click("Toggle tax (8%)", "toggleTax");
      await until("Tax: $3.78", "Total: $51.03");

      // Nothing failed along the way.
      expect(output).not.toContain("✖");
    } finally {
      socket.close();
    }
  }, 30_000);
});
