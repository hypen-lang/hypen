/**
 * Hypen Example Server for Android Renderer
 *
 * Run with: bun run server.ts
 */

import { RemoteServer } from "../../hypen-web/packages/server/src/index.ts";

// Import examples
import { counterModule, counterUI } from "./examples/counter.ts";
import { todoModule, todoUI } from "./examples/todo.ts";
import { weatherModule, weatherUI } from "./examples/weather.ts";
import { notesModule, notesUI } from "./examples/notes.ts";
import { calculatorModule, calculatorUI } from "./examples/calculator.ts";
import { profileModule, profileUI } from "./examples/profile.ts";

// Server Configuration
const BASE_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const EXAMPLES = [
  { key: "counter", name: "Counter", module: counterModule, ui: counterUI },
  { key: "todo", name: "Todo List", module: todoModule, ui: todoUI },
  { key: "weather", name: "Weather", module: weatherModule, ui: weatherUI },
  { key: "notes", name: "Notes", module: notesModule, ui: notesUI },
  { key: "calculator", name: "Calculator", module: calculatorModule, ui: calculatorUI },
  { key: "profile", name: "Profile", module: profileModule, ui: profileUI },
];

// Start servers
EXAMPLES.forEach((example, index) => {
  const port = BASE_PORT + index;
  new RemoteServer()
    .module(example.name, example.module)
    .ui(example.ui)
    .onConnection((client) => console.log(`[${example.name}] Connected: ${client.id}`))
    .onDisconnection((client) => console.log(`[${example.name}] Disconnected: ${client.id}`))
    .listen(port);
});

console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Hypen Example Server                            ║
╠══════════════════════════════════════════════════════════════╣
${EXAMPLES.map((ex, i) => `║  ${ex.name.padEnd(14)} ws://localhost:${BASE_PORT + i}`.padEnd(62) + '║').join('\n')}
╠══════════════════════════════════════════════════════════════╣
║  Emulator:  Replace 'localhost' with '10.0.2.2'              ║
║  Device:    Use your machine's IP address                    ║
╚══════════════════════════════════════════════════════════════╝
`);
