/**
 * The entire app, in one file — no do.ts, no engine.ts, no wasm wiring, and no
 * client files. `serveClient: true` serves a browser DOM client at `/` from the
 * prebuilt generic client in `@hypen-space/cf`; opening the URL just renders.
 */

import { defineHypenWorker } from "@hypen-space/cf/worker";
import { app } from "@hypen-space/core";

// `location` is the Router's default binding — it drives the active route and
// the nav highlight. (Pass `Router(value: @{state.x})` to bind a different key.)
const counter = app
  .defineState({ count: 0, location: "/" })
  .onAction("inc", ({ state }) => {
    state.count += 1;
  })
  .ui(`
    module App {
      Column {
        Row {
          Button("@actions.inc") { Text("Home") }
            .color("@{state.location == '/' ? '#2563eb' : '#9ca3af'}")
          Button("@router.push", to: "/about") { Text("About") }
            .color("@{state.location == '/about' ? '#2563eb' : '#9ca3af'}")
        }
          .tw("gap-4 p-4")

        Router {
          Route(path: "/") {
            Column {
              Text("Count: @{state.count}")
                .tw("text-3xl font-bold")
              Button("@actions.inc") { Text("Increment") }
                .tw("bg-blue-600 text-white rounded px-4 py-2 mt-3")
            }
              .tw("items-center justify-center flex-1 gap-2")
          }
          Route(path: "/about") {
            Text("A whole Hypen app in one worker.ts.")
              .tw("text-xl p-8")
          }
        }
          .tw("flex-1")
      }
        .tw("flex-1 min-h-screen items-center bg-white")
    }
  `);

const worker = defineHypenWorker({
  module: counter,
  doClassName: "SimpleDO",
  binding: "SIMPLE_DO",
  serveClient: true, // DOM client at "/"
});

export const SimpleDO = worker.SimpleDO;
export default { fetch: worker.fetch };
