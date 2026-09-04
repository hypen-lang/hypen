/**
 * Where to find Chromium.
 *
 * Agent/CI containers ship a preinstalled build at `/opt/pw-browsers/chromium`;
 * elsewhere fall back to whatever `playwright-core` resolves, or an explicit
 * `CHROMIUM_PATH` from the environment.
 */

import { existsSync } from "node:fs";

const PRESET = "/opt/pw-browsers/chromium";

export const CHROMIUM_PATH: string | undefined =
  process.env.CHROMIUM_PATH ?? (existsSync(PRESET) ? PRESET : undefined);

/**
 * Flags that make the numbers reproducible: fixed window size, no GPU
 * rasterisation variance, and `--expose-gc` + precise memory so the heap
 * readings are taken after a real collection rather than whenever the
 * browser felt like one.
 */
export const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--js-flags=--expose-gc",
  "--enable-precise-memory-info",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--force-device-scale-factor=1",
];
