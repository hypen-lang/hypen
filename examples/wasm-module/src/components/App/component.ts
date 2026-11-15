import { app } from "@hypen-space/core";

// The entry module. It owns no logic: it lays out the two modules that do —
// `Cart` (TypeScript, ./Cart) and `Pricing` (a prebuilt Rust component,
// declared in hypen.json under wasm.modules.Pricing).
export default app.defineState({ title: "Cart + Pricing" }).build();
