/** Verify checked-in WASM actually serves the engine-derived MCP surface. */

import { describe, expect, test } from "bun:test";
import { Engine } from "../../server/src/engine.js";
import { HypenMcpServer } from "../src/server.js";

const CART = `
  module Cart {
    Router {
      Route(path: "/cart") {
        Column {
          Text("Total: @{state.total}")
          Input(placeholder: "Coupon").bind(@state.coupon)
          Button("Go").onClick(@actions.checkout)
        }
      }
      Route(path: "/orders") { Text("orders") }
    }
  }
`;

describe("against the real engine", () => {
  test("serves the checked-in engine manifest", async () => {
    const engine = new Engine();
    await engine.init();
    engine.setRenderCallback(() => {});
    engine.renderSource(CART);
    engine.setModule("Cart", ["checkout"], ["total", "coupon"], {
      total: 4780,
      coupon: "",
      _token: "secret",
    });
    engine.onAction("checkout", () => {});

    const server = new HypenMcpServer({ engine });

    // The binding exists: everything below runs against real WASM.
    const call = (method: string, params?: unknown) =>
      server.handle({ jsonrpc: "2.0", id: 1, method, params })!;

    const tools = (call("tools/list").result as any).tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain("checkout");
    expect(tools.map((t) => t.name)).toContain("hypen_navigate");

    // Everything advertised is reachable, and nothing else is: the guard's
    // invariant, seen from the transport.
    const resources = (call("resources/list").result as any).resources as Array<{
      uri: string;
    }>;
    for (const resource of resources) {
      const read = call("resources/read", { uri: resource.uri });
      expect(read.error).toBeUndefined();
    }
    expect(resources.map((r) => r.uri)).not.toContain("hypen://state/cart/_token");
    expect(call("resources/read", { uri: "hypen://state/cart/_token" }).error!.code).toBe(
      -32002,
    );
  });
});


test("browser WASM publishes the manifest and accepts wildcard destinations", () => {
  // Other suites mock the browser module process-wide. A fresh process proves
  // this checked-in artifact, regardless of the full suite's execution order.
  const moduleUrl = new URL("../../web-engine/wasm-browser/hypen_engine.js", import.meta.url).href;
  const wasmUrl = new URL("../../web-engine/wasm-browser/hypen_engine_bg.wasm", import.meta.url).href;
  const script = `
    import init, { WasmEngine } from ${JSON.stringify(moduleUrl)};
    await init({ module_or_path: await Bun.file(new URL(${JSON.stringify(wasmUrl)})).arrayBuffer() });
    const engine = new WasmEngine();
    engine.registerDefaultPrimitives();
    engine.setRenderCallback(() => {});
    engine.renderSource('module Docs { Router { Route(path: "/docs/*") { Text("docs") } } }');
    console.log(JSON.stringify(engine.mcpManifest()));
    engine.free();
  `;
  const run = Bun.spawnSync([process.execPath, "--eval", script]);
  expect(run.exitCode).toBe(0);
  const manifest = JSON.parse(run.stdout.toString());
  const navigate = manifest.tools.find((tool: any) => tool.name === "hypen_navigate");
  expect(navigate).toBeDefined();
  expect(navigate.inputSchema.properties.to.enum).toBeUndefined();
});

test("MCP discovers projected rows and dispatches the selected row", async () => {
  const engine = new Engine();
  await engine.init();
  engine.setRenderCallback(() => {});
  engine.renderSource(`module Shop {
    List(@state.products, as: product) {
      Text("@{product.title}")
      Button("Add").onClick(@actions.add, sku: @product.sku)
      Button("Private").onClick(@actions._inspect, token: @product.token)
    }
  }`);
  engine.setModule("Shop", ["add", "_inspect"], ["products"], {
    products: [
      { title: "Hat", sku: "HAT", token: "secret-a" },
      { title: "Shirt", sku: "SHIRT", token: "secret-b" },
    ],
  });
  let selected: unknown;
  engine.onAction("add", (action) => { selected = action.payload; });
  engine.onAction("_inspect", () => {});
  const server = new HypenMcpServer({ engine });
  const call = (method: string, params?: unknown) =>
    server.handle({ jsonrpc: "2.0", id: 1, method, params })!;
  const listed = (call("tools/list").result as any).tools;
  expect(listed.find((tool: any) => tool.name === "add").inputSchema.properties).toHaveProperty("sku");
  expect(listed.some((tool: any) => tool.name === "_inspect")).toBe(false);
  const resource = (call("resources/list").result as any).resources.find(
    (entry: any) => entry.uri === "hypen://state/shop/products",
  );
  expect(resource).toBeDefined();
  const result = call("resources/read", { uri: resource.uri }).result as any;
  const rows = JSON.parse(result.contents[0].text);
  expect(rows).toEqual([{ title: "Hat", sku: "HAT" }, { title: "Shirt", sku: "SHIRT" }]);
  expect(engine.getStateAt(null, "products.1.token")).toBeUndefined();
  expect(call("tools/call", { name: "add", arguments: { sku: rows[1].sku } }).error).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selected).toEqual({ sku: "SHIRT" });
});
