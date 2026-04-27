/**
 * Performance benchmark for state updates
 *
 * Tests how the engine performs with large state objects
 * to identify potential bottlenecks in the state synchronization path.
 */

import { describe, test, expect } from "bun:test";
// Import directly from nodejs package (works in Bun)
import { WasmEngine } from "../../hypen-engine-rs/pkg/nodejs/hypen_engine.js";

// Helper to create a large state object
function createLargeState(options: {
  numKeys?: number;
  numArrayItems?: number;
  nestedDepth?: number;
  stringLength?: number;
}): Record<string, any> {
  const {
    numKeys = 100,
    numArrayItems = 100,
    nestedDepth = 3,
    stringLength = 100,
  } = options;

  const state: Record<string, any> = {};

  // Add simple key-value pairs
  for (let i = 0; i < numKeys; i++) {
    state[`key_${i}`] = `value_${"x".repeat(stringLength)}_${i}`;
  }

  // Add arrays
  state.items = Array.from({ length: numArrayItems }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    description: "x".repeat(stringLength),
    tags: ["tag1", "tag2", "tag3"],
    metadata: { created: Date.now(), updated: Date.now() },
  }));

  // Add nested objects
  function createNestedObject(depth: number): any {
    if (depth === 0) {
      return { value: "x".repeat(stringLength) };
    }
    return {
      level: depth,
      data: "x".repeat(stringLength / nestedDepth),
      child: createNestedObject(depth - 1),
    };
  }
  state.nested = createNestedObject(nestedDepth);

  // Add a counter (the value we'll actually update)
  state.counter = 0;

  return state;
}

// Measure state size in bytes (approximate)
function measureStateSize(state: any): number {
  return JSON.stringify(state).length;
}

// Simple engine wrapper for testing
class TestEngine {
  private engine: WasmEngine;
  private patches: any[] = [];

  constructor() {
    this.engine = new WasmEngine();
    this.engine.setRenderCallback((patches: any[]) => {
      this.patches = patches;
    });
  }

  setModule(name: string, actions: string[], stateKeys: string[], initialState: any) {
    this.engine.setModule(name, actions, stateKeys, initialState);
  }

  renderSource(source: string) {
    this.engine.renderSource(source);
  }

  updateState(state: any) {
    this.engine.updateState(state);
  }

  getPatches() {
    return this.patches;
  }
}

describe("State Update Performance", () => {

  test("benchmark: small state updates per second", () => {
    const engine = new TestEngine();

    // Small state - just a counter
    const smallState = { counter: 0 };

    engine.setModule("test", [], ["counter"], smallState);
    engine.renderSource('Text("Counter: @{state.counter}")');

    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      smallState.counter = i;
      engine.updateState(smallState);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`\n📊 Small State Benchmark (${measureStateSize(smallState)} bytes):`);
    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);

    expect(updatesPerSecond).toBeGreaterThan(1000); // Should handle 1000+ updates/sec
  });

  test("benchmark: medium state (10KB) updates per second", () => {
    const engine = new TestEngine();

    // Medium state - ~10KB
    const mediumState = createLargeState({
      numKeys: 50,
      numArrayItems: 20,
      nestedDepth: 3,
      stringLength: 50,
    });

    const stateSize = measureStateSize(mediumState);
    console.log(`\n📊 Medium State Benchmark (${(stateSize / 1024).toFixed(1)}KB):`);

    engine.setModule("test", [], Object.keys(mediumState), mediumState);
    engine.renderSource('Text("Counter: @{state.counter}")');

    const iterations = 500;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      mediumState.counter = i;
      engine.updateState(mediumState);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);

    expect(updatesPerSecond).toBeGreaterThan(100); // Should handle 100+ updates/sec
  });

  test("benchmark: large state (100KB) updates per second", () => {
    const engine = new TestEngine();

    // Large state - ~100KB
    const largeState = createLargeState({
      numKeys: 200,
      numArrayItems: 100,
      nestedDepth: 5,
      stringLength: 200,
    });

    const stateSize = measureStateSize(largeState);
    console.log(`\n📊 Large State Benchmark (${(stateSize / 1024).toFixed(1)}KB):`);

    engine.setModule("test", [], Object.keys(largeState), largeState);
    engine.renderSource('Text("Counter: @{state.counter}")');

    const iterations = 200;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      largeState.counter = i;
      engine.updateState(largeState);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);

    expect(updatesPerSecond).toBeGreaterThan(10); // Should handle 10+ updates/sec
  });

  test("benchmark: very large state (1MB) updates per second", () => {
    const engine = new TestEngine();

    // Very large state - ~1MB
    const veryLargeState = createLargeState({
      numKeys: 500,
      numArrayItems: 500,
      nestedDepth: 6,
      stringLength: 500,
    });

    const stateSize = measureStateSize(veryLargeState);
    console.log(`\n📊 Very Large State Benchmark (${(stateSize / 1024).toFixed(1)}KB):`);

    engine.setModule("test", [], Object.keys(veryLargeState), veryLargeState);
    engine.renderSource('Text("Counter: @{state.counter}")');

    const iterations = 50;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      veryLargeState.counter = i;
      engine.updateState(veryLargeState);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);

    // Even with 1MB state, should be usable
    expect(updatesPerSecond).toBeGreaterThan(1);
  });

  test("benchmark: complex UI with many bindings", () => {
    const engine = new TestEngine();

    // State with many individual values that could be bound
    const state: Record<string, any> = { counter: 0 };
    for (let i = 0; i < 50; i++) {
      state[`field_${i}`] = `value_${i}`;
    }

    const stateSize = measureStateSize(state);
    console.log(`\n📊 Many Bindings Benchmark (${stateSize} bytes, 50 bindings):`);

    engine.setModule("test", [], Object.keys(state), state);

    // Create UI with many bound text elements
    const uiElements = Array.from({ length: 50 }, (_, i) =>
      `Text("@{state.field_${i}}")`
    ).join("\n");

    engine.renderSource(`Column { ${uiElements} }`);

    const iterations = 200;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      // Update all fields
      for (let j = 0; j < 50; j++) {
        state[`field_${j}`] = `updated_${i}_${j}`;
      }
      engine.updateState(state);
    }

    const elapsed = performance.now() - start;
    const updatesPerSecond = (iterations / elapsed) * 1000;

    console.log(`   ${iterations} updates in ${elapsed.toFixed(2)}ms`);
    console.log(`   ${updatesPerSecond.toFixed(0)} updates/second`);
    console.log(`   ${(elapsed / iterations).toFixed(3)}ms per update`);

    expect(updatesPerSecond).toBeGreaterThan(50);
  });

  test("benchmark: incremental vs full state update comparison", () => {
    const engine = new TestEngine();

    // Create a medium-sized state
    const state = createLargeState({
      numKeys: 100,
      numArrayItems: 50,
      nestedDepth: 4,
      stringLength: 100,
    });

    const stateSize = measureStateSize(state);
    console.log(`\n📊 Incremental vs Full State Comparison (${(stateSize / 1024).toFixed(1)}KB):`);

    engine.setModule("test", [], Object.keys(state), state);
    engine.renderSource('Text("Counter: @{state.counter}")');

    // Measure full state updates (current approach)
    const fullIterations = 200;
    const fullStart = performance.now();

    for (let i = 0; i < fullIterations; i++) {
      state.counter = i;
      engine.updateState(state); // Full state
    }

    const fullElapsed = performance.now() - fullStart;
    const fullUpdatesPerSecond = (fullIterations / fullElapsed) * 1000;

    console.log(`   Full state: ${fullUpdatesPerSecond.toFixed(0)} updates/sec (${(fullElapsed / fullIterations).toFixed(3)}ms each)`);

    // Measure what incremental updates COULD look like (just the changed path)
    // This simulates sending only { counter: X } instead of the full state
    const incrementalEngine = new TestEngine();
    incrementalEngine.setModule("test", [], ["counter"], { counter: 0 });
    incrementalEngine.renderSource('Text("Counter: @{state.counter}")');

    const incrementalState = { counter: 0 };
    const incrementalIterations = 200;
    const incrementalStart = performance.now();

    for (let i = 0; i < incrementalIterations; i++) {
      incrementalState.counter = i;
      // This is what incremental would look like - only the changed value
      incrementalEngine.updateState(incrementalState);
    }

    const incrementalElapsed = performance.now() - incrementalStart;
    const incrementalUpdatesPerSecond = (incrementalIterations / incrementalElapsed) * 1000;

    console.log(`   Incremental: ${incrementalUpdatesPerSecond.toFixed(0)} updates/sec (${(incrementalElapsed / incrementalIterations).toFixed(3)}ms each)`);
    console.log(`   Speedup potential: ${(incrementalUpdatesPerSecond / fullUpdatesPerSecond).toFixed(1)}x`);

    // The incremental approach should be significantly faster
    expect(incrementalUpdatesPerSecond).toBeGreaterThan(fullUpdatesPerSecond);
  });

  test("profile: breakdown of update time", () => {
    const engine = new TestEngine();

    const state = createLargeState({
      numKeys: 100,
      numArrayItems: 50,
      nestedDepth: 4,
      stringLength: 100,
    });

    const stateSize = measureStateSize(state);
    console.log(`\n📊 Update Time Breakdown (${(stateSize / 1024).toFixed(1)}KB state):`);

    engine.setModule("test", [], Object.keys(state), state);
    engine.renderSource('Text("Counter: @{state.counter}")');

    const iterations = 100;

    // Measure JSON serialization time (TypeScript side)
    let serializationTime = 0;
    for (let i = 0; i < iterations; i++) {
      state.counter = i;
      const start = performance.now();
      JSON.stringify(state);
      serializationTime += performance.now() - start;
    }

    // Measure full updateState time
    let totalUpdateTime = 0;
    for (let i = 0; i < iterations; i++) {
      state.counter = i;
      const start = performance.now();
      engine.updateState(state);
      totalUpdateTime += performance.now() - start;
    }

    const avgSerialization = serializationTime / iterations;
    const avgTotal = totalUpdateTime / iterations;
    const avgWasmProcessing = avgTotal - avgSerialization;

    console.log(`   JSON serialization: ${avgSerialization.toFixed(3)}ms avg`);
    console.log(`   Total updateState:  ${avgTotal.toFixed(3)}ms avg`);
    console.log(`   WASM processing:    ${avgWasmProcessing.toFixed(3)}ms avg (estimated)`);
    console.log(`   Serialization %:    ${((avgSerialization / avgTotal) * 100).toFixed(1)}%`);
  });
});
