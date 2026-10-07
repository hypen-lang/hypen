/** Opt-in native smoke server. Run with Bun; bind only to loopback. */
import { app } from "../../packages/core/src/index.ts";
import { RemoteServer } from "../../packages/server/src/remote/server.ts";

const module = app.defineState({ result: "waiting" })
  .onAction("probe", async ({ state, context }) => {
    const supported = context.device.supports("permission.query");
    const result = await context.device.permissions.query("camera");
    state.result = `native-probe:${JSON.stringify({ supported, result })}`;
    console.log(state.result);
  }).build();
const server = new RemoteServer().module("App", module)
  .ui('Text("@{state.result}")')
  .config({ hostname: "127.0.0.1", webClient: false,
    authenticate: (request: Request) => request.headers.get("authorization") === "Bearer native-probe" })
  .enableDevice();
await server.listen(44990);
console.log("Native device probe listening on 44990");
