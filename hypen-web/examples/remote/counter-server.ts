/**
 * Example: Remote Counter Server
 *
 * Stream a counter app over WebSocket using RemoteServer
 */

import { app } from "../../packages/core/src/app.js";
import { RemoteServer } from "../../packages/server/src/remote/server.js";

// Define the Counter module
type CounterState = {
  count: number;
};

const counterModule = app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state) => {
    console.log("✓ Counter module created");
  })
  .onAction("increment", async ({ action, state }) => {
    state.count += action.payload?.amount || 1;
    console.log(`→ Incremented to ${state.count}`);
  })
  .onAction("decrement", async ({ action, state }) => {
    state.count -= action.payload?.amount || 1;
    console.log(`→ Decremented to ${state.count}`);
  })
  .onAction("reset", async ({ state }) => {
    state.count = 0;
    console.log(`→ Reset to 0`);
  })
  .build();

// Hypen DSL for the UI
const counterUI = `
  Column {
    Text("Count: @{state.count}")
      .fontSize(32)
      .fontWeight("bold")
      .padding(20)

    Row {
      Button { Text("-") }
        .onClick(@actions.decrement)
        .padding(10)
        .margin(5)

      Button { Text("Reset") }
        .onClick(@actions.reset)
        .padding(10)
        .margin(5)

      Button { Text("+") }
        .onClick(@actions.increment)
        .padding(10)
        .margin(5)
    }
  }
`;

// Create and start the remote server
const server = new RemoteServer()
  .module("Counter", counterModule)
  .ui(counterUI)
  .onConnection((client) => {
    console.log(`✓ Client ${client.id} connected`);
  })
  .onDisconnection((client) => {
    console.log(`✗ Client ${client.id} disconnected`);
  })
  .listen(3000);

console.log("\n=== Hypen Remote Counter Server ===");
console.log("Connect clients to: ws://localhost:3000");
console.log("Press Ctrl+C to stop\n");
