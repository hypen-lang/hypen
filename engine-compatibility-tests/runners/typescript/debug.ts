// Debug script to see actual engine patch output
import { Engine } from "../../../hypen-web/packages/core/src/engine";

async function debug() {
  const engine = new Engine();
  await engine.init();

  engine.setRenderCallback((patches) => {
    console.log("Patches received:");
    console.log(JSON.stringify(patches, null, 2));
  });

  // Test 1: Simple text
  console.log("\n=== Test 1: Simple Text ===");
  engine.renderSource('Text("Hello, World!")');

  // Test 2: With module and state - try different syntaxes
  console.log("\n=== Test 2: With State Binding ===");
  engine.clearTree();
  engine.setModule("TestModule", [], ["message"], { message: "Hello from state" });

  // Try quoted binding
  try {
    engine.renderSource('Text("@{state.message}")');
  } catch (e) {
    console.log("Quoted binding error:", e);
  }

  // Try with text: named arg
  console.log("\n=== Test 2b: Named arg ===");
  engine.clearTree();
  try {
    engine.renderSource('Text(text: "@{state.message}")');
  } catch (e) {
    console.log("Named arg error:", e);
  }

  // Test 3: Nested components
  console.log("\n=== Test 3: Nested Components ===");
  engine.clearTree();
  engine.renderSource('Column { Text("Child 1") Text("Child 2") }');
}

debug().catch(console.error);
