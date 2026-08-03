/**
 * Hypen Home on Cloudflare — a phone-style home screen for Hypen apps.
 *
 * All the interesting bits (the APPS list and the generated home-screen DSL)
 * live in launcher.ts. The batteries-included `@hypen-space/cf/worker` entry
 * imports the WASM engine itself, so this file is just the wiring.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import launcher from "./launcher";

const worker = defineHypenWorker({
  module: launcher,
  doClassName: "HomeScreenDO",
  binding: "HOME_SCREEN_DO",
  serveClient: true, // DOM client at "/"
  title: "Hypen Home",
});

export const HomeScreenDO = worker.HomeScreenDO;
export default { fetch: worker.fetch };
