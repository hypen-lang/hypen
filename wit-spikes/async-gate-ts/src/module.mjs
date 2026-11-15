// The componentize-js async GATE module (roadmap step 4).
//
// A minimal JS module implementing the CM-async `hypen:module@0.2.0`
// `module` world directly: `dispatch` is an async export that `await`s a
// *custom* async host import (hypen:storage local bucket set + get) before
// returning its delta. This is exactly the capability componentize-js /
// StarlingMonkey has historically lacked (it can await built-in wasi:http,
// but not bind a custom async host import — and it "syncifies" exports).
//
// The gate is BEHAVIORAL, not build-time: jco may well componentize this
// file without complaint and still produce a component whose sync-lowered
// import hangs at runtime. The Rust side (`test_async_gate_ts.rs`) drives
// the built component on WasmtimeHostAsync under a deadline and passes only
// when the awaited round-trip completes with the right value.

const enc = new TextEncoder();
const dec = new TextDecoder();

// Custom async host import — the whole point of the gate. jco exposes WIT
// resources as classes on the import specifier; `open` is `static async
// func` and every method is `async func` in hypen:storage@0.2.0.
import { Bucket } from "hypen:storage/local@0.2.0";

function countOf(bytes) {
  try {
    const v = JSON.parse(dec.decode(bytes));
    return typeof v.count === "number" ? v.count : 0;
  } catch {
    return 0;
  }
}

function encodeCount(count) {
  return enc.encode(JSON.stringify({ count }));
}

export async function init(_config) {
  // Awaited storage warm-start, mirroring the Rust reference module.
  const bucket = await Bucket.open("persistent", "gate");
  const stored = await bucket.get("count");
  return stored ?? encodeCount(0);
}

export async function dispatch(stateBytes, action) {
  if (action.name !== "increment") {
    throw new Error(`unknown action: ${action.name}`);
  }
  const next = countOf(stateBytes) + 1;
  const newState = encodeCount(next);
  // Sequential awaits across the custom async host import: persist, then
  // read back. If componentize-js can't drive a custom async import, this
  // is where the component hangs or traps — the gate's failure mode.
  const bucket = await Bucket.open("persistent", "gate");
  await bucket.set("count", newState);
  const echoed = await bucket.get("count");
  if (echoed === undefined) {
    throw new Error("persisted count vanished");
  }
  return { state: echoed, effects: [], emit: [] };
}

export async function onActivated(_state) {
  return { state: undefined, effects: [], emit: [] };
}

export async function onDeactivated(_state) {
  return { state: undefined, effects: [], emit: [] };
}

export async function onDestroyed(_state) {}

export function actions() {
  return ["increment"];
}
