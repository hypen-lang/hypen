/**
 * Hypen Todo on Cloudflare — the hypen-landing todo sample as a worker.
 *
 * The batteries-included `@hypen-space/cf/worker` entry imports the WASM
 * engine itself, so this file is just the module + one `defineHypenWorker`
 * call. The default worker routing keys every `/ws` connection to the SAME
 * Durable Object and `syncActions: true` mirrors state updates to every
 * socket on it — one shared todo list per deployment, live in all tabs.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import todo from "./todo";

const worker = defineHypenWorker({
  module: todo,
  doClassName: "TodoDO",
  binding: "TODO_DO",
  syncActions: true,
  serveClient: true, // DOM client at "/"
  title: "Hypen Todo",
});

export const TodoDO = worker.TodoDO;
export default { fetch: worker.fetch };
