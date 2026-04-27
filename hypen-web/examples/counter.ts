/**
 * Counter Example - demonstrates basic module usage with Hypen
 *
 * This is a console-based example that runs in Bun/Node.js.
 * For browser-based rendering with DOM, see the playground.
 */

import { Engine, app, HypenModuleInstance, ConsoleRenderer } from "../packages/core/src/index.js";

// Define the Counter module
type CounterState = {
  count: number;
};

const counterModule = app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state) => {
    console.log("✓ Counter module created with initial state:", state);
  })
  .onAction("increment", async ({ action, state }) => {
    state.count += (action.payload?.amount || 1);
    console.log(`  Incremented to ${state.count}`);
  })
  .onAction("decrement", async ({ action, state }) => {
    state.count -= (action.payload?.amount || 1);
    console.log(`  Decremented to ${state.count}`);
  })
  .onAction("reset", async ({ state }) => {
    state.count = 0;
    console.log("  Reset to 0");
  })
  .onDestroyed(async (state) => {
    console.log("✓ Counter module destroyed with final count:", state.count);
  })
  .build();

// Hypen DSL for the UI
const counterUI = `
  Column {
    Text("Count: @{state.count}")
    Row {
      Button { Text("-") }.onClick(@actions.decrement)
      Button { Text("Reset") }.onClick(@actions.reset)
      Button { Text("+") }.onClick(@actions.increment)
    }
  }
`;

async function main() {
  console.log("=== Hypen Counter Example ===\n");

  // Initialize engine
  console.log("Initializing engine...");
  const engine = new Engine();
  await engine.init();
  console.log("✓ Engine initialized\n");

  // Create console renderer (logs patches)
  const renderer = new ConsoleRenderer();

  // Set render callback
  engine.setRenderCallback((patches) => {
    console.log("\n📦 Patches received from engine:");
    renderer.applyPatches(patches);
  });

  // Create module instance
  console.log("Creating module instance...");
  const moduleInstance = new HypenModuleInstance(engine, counterModule);

  // Render the UI
  console.log("Rendering UI...");
  engine.renderSource(counterUI);

  // Simulate user interactions
  console.log("\n\n=== Simulating Actions ===");

  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log("\n[Action 1] Incrementing by 5...");
  engine.dispatchAction("increment", { amount: 5 });

  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log("\n[Action 2] Decrementing by 2...");
  engine.dispatchAction("decrement", { amount: 2 });

  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log("\n[Action 3] Incrementing by 1...");
  engine.dispatchAction("increment");

  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log("\n[Action 4] Resetting...");
  engine.dispatchAction("reset");

  // Get final state
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log("\n\n=== Final State ===");
  console.log("Count:", moduleInstance.getState().count);

  // Cleanup
  console.log("\nCleaning up...");
  await moduleInstance.destroy();

  console.log("\n=== Example Complete ===");
}

// Run if this is the main module
if (import.meta.main) {
  main().catch(console.error);
}

export { counterModule, counterUI };
