/**
 * Preload file to register the Hypen plugin
 *
 * Usage:
 *   bun --preload @hypen-space/server/preload ./src/main.ts
 *
 * Or add to bunfig.toml:
 *   [run]
 *   preload = ["@hypen-space/server/preload"]
 */

import { registerHypenPlugin } from "./packages/server/src/plugin.js";

registerHypenPlugin({
  debug: process.env.HYPEN_DEBUG === "true",
});
