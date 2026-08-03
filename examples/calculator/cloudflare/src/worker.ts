/**
 * Hypen Calculator on Cloudflare — the hypen-landing calculator sample as a
 * worker. The batteries-included `@hypen-space/cf/worker` entry imports the
 * WASM engine itself, so this file is just the module + one
 * `defineHypenWorker` call.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import calculator from "./calculator";

const worker = defineHypenWorker({
  module: calculator,
  doClassName: "CalculatorDO",
  binding: "CALCULATOR_DO",
  serveClient: true, // DOM client at "/"
  title: "Hypen Calculator",
});

export const CalculatorDO = worker.CalculatorDO;
export default { fetch: worker.fetch };
