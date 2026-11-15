import { app } from "@hypen-space/core";

// The entry module, an ordinary in-process TypeScript module. It owns no
// logic: it lays out `Weather`, which is a prebuilt WebAssembly component
// (TypeScript source in modules/weather/, declared in hypen.json under
// wasm.modules.Weather).
export default app.defineState({ title: "Weather" }).build();
