/**
 * Engine Compatibility Test Runner for TypeScript/WASM
 *
 * Loads JSON test fixtures and runs them against the WASM engine.
 * Run with: bun test compatibility.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Engine, type Patch, type Action } from "../../../hypen-web/packages/server/src/engine";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Actual patch format from the engine (camelCase, matching schema)
interface EnginePatch {
  type: string;
  id?: string;
  elementType?: string;
  props?: Record<string, any>;
  name?: string;
  value?: any;
  text?: string;
  parentId?: string;
  beforeId?: string | null;
  eventName?: string;
}

// Test case types
interface StateChange {
  paths: string[];
  newValues: Record<string, any>;
}

interface ExpectedPatch {
  type: string;
  elementType?: string;
  props?: Record<string, any>;
  name?: string;
  value?: any;
  text?: string;
}

interface TestStep {
  description?: string;
  action: "initialRender" | "updateState" | "dispatchAction";
  stateChange?: StateChange;
  dispatchAction?: Action;
  expectedPatches?: ExpectedPatch[];
  expectedPatchCount?: number;
  expectedPatchTypes?: string[];
  forbiddenPatchTypes?: string[];
  expectedState?: Record<string, any>;
}

interface TestCase {
  name: string;
  description: string;
  category: string;
  priority?: string;
  input: {
    source: string;
    initialState?: Record<string, any>;
    module?: {
      name: string;
      actions?: string[];
      stateKeys?: string[];
    };
  };
  expected?: {
    patches?: ExpectedPatch[];
    patchCount?: number;
    patchTypes?: string[];
  };
  steps?: TestStep[];
  skip?: {
    reason?: string;
    sdks?: string[];
  };
}

// State management for action handlers
let currentState: Record<string, any> = {};

// Action handler implementations for tests
const actionHandlers: Record<string, (action: Action, state: Record<string, any>) => Record<string, any>> = {
  handleClick: (_action, state) => ({ ...state, clicked: true }),
  selectItem: (action, state) => ({ ...state, selectedId: action.payload?.id ?? null }),
};

// Find all JSON fixture files. Skips `portable/` — those fixtures use
// a different schema ({function, input, expected}) and have their own
// runner at portable.test.ts. Without this filter the engine-level
// runner would try to render them as DSL and report every single one
// as `[undefined] name — ...` (no `category`).
async function findFixtures(dir: string): Promise<string[]> {
  const fixtures: string[] = [];

  async function walk(currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "portable") continue;
        await walk(fullPath);
      } else if (entry.name.endsWith(".json")) {
        fixtures.push(fullPath);
      }
    }
  }

  await walk(dir);
  return fixtures;
}

// Load and parse a fixture file
async function loadFixture(path: string): Promise<TestCase> {
  const file = Bun.file(path);
  return await file.json();
}

// Normalize patches for comparison (handle Map vs object)
function normalizePatches(patches: any[]): EnginePatch[] {
  return patches.map((patch) => {
    const normalized: EnginePatch = { ...patch };

    // Convert Map to object if present
    if (normalized.props instanceof Map) {
      normalized.props = Object.fromEntries(normalized.props);
    }

    return normalized;
  });
}

// Match patches by structure, ignoring IDs
function matchPatchStructure(actual: EnginePatch[], expected: ExpectedPatch[]): boolean {
  if (actual.length !== expected.length) return false;

  // Group patches by type for structural comparison
  const actualByType = groupByType(actual);
  const expectedByType = groupByType(expected);

  for (const [type, expectedPatches] of Object.entries(expectedByType)) {
    const actualPatches = actualByType[type] || [];
    if (actualPatches.length !== expectedPatches.length) return false;

    // For each expected patch of this type, verify there's a matching actual patch
    for (const exp of expectedPatches) {
      const hasMatch = actualPatches.some((act) => patchMatches(act, exp));
      if (!hasMatch) return false;
    }
  }

  return true;
}

function groupByType<T extends { type: string }>(patches: T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const patch of patches) {
    if (!groups[patch.type]) groups[patch.type] = [];
    groups[patch.type].push(patch);
  }
  return groups;
}

function patchMatches(actual: EnginePatch, expected: ExpectedPatch): boolean {
  if (actual.type !== expected.type) return false;

  // Check elementType if specified
  if (expected.elementType !== undefined && actual.elementType !== expected.elementType) {
    return false;
  }

  // Check props if specified (partial match)
  if (expected.props !== undefined) {
    for (const [key, value] of Object.entries(expected.props)) {
      if (actual.props?.[key] !== value) return false;
    }
  }

  // Check name/value for setProp patches
  if (expected.name !== undefined && actual.name !== expected.name) return false;
  if (expected.value !== undefined && actual.value !== expected.value) return false;

  return true;
}

// Main test runner
const fixturesDir = join(import.meta.dir, "../../fixtures");

describe("Engine Compatibility Tests", async () => {
  const fixturePaths = await findFixtures(fixturesDir);

  for (const fixturePath of fixturePaths) {
    const testCase = await loadFixture(fixturePath);
    const relativePath = relative(fixturesDir, fixturePath);

    // Skip if marked for TypeScript SDK
    if (testCase.skip?.sdks?.includes("typescript")) {
      test.skip(`[${relativePath}] ${testCase.name}: ${testCase.description}`, () => {});
      continue;
    }

    describe(`[${testCase.category}] ${testCase.name}`, () => {
      let engine: Engine;
      let collectedPatches: EnginePatch[];
      let patchCallback: (patches: any[]) => void;

      beforeEach(async () => {
        engine = new Engine();
        await engine.init();

        collectedPatches = [];
        patchCallback = (patches: any[]) => {
          collectedPatches.push(...normalizePatches(patches));
        };

        engine.setRenderCallback(patchCallback);

        // Reset current state
        currentState = { ...(testCase.input.initialState ?? {}) };

        // Set up module if specified
        if (testCase.input.module) {
          engine.setModule(
            testCase.input.module.name,
            testCase.input.module.actions ?? [],
            testCase.input.module.stateKeys ?? [],
            currentState
          );

          // Register action handlers
          for (const actionName of testCase.input.module.actions ?? []) {
            engine.onAction(actionName, (action) => {
              const handler = actionHandlers[actionName];
              if (handler) {
                currentState = handler(action, currentState);
                // Notify engine of state change
                const paths = Object.keys(currentState);
                const values: Record<string, any> = {};
                for (const path of paths) {
                  values[path] = currentState[path];
                }
                engine.updateStateSparse(null, paths, values);
              }
            });
          }
        }
      });

      test(testCase.description, async () => {
        // Simple test case (expected patches from initial render)
        if (testCase.expected && !testCase.steps) {
          engine.renderSource(testCase.input.source);

          // Check patch count
          if (testCase.expected.patchCount !== undefined) {
            expect(collectedPatches.length).toBe(testCase.expected.patchCount);
          }

          // Check patch types
          if (testCase.expected.patchTypes) {
            const actualTypes = collectedPatches.map((p) => p.type);
            expect(actualTypes).toEqual(testCase.expected.patchTypes);
          }

          // Check patch structure (ignoring IDs)
          if (testCase.expected.patches) {
            const matches = matchPatchStructure(collectedPatches, testCase.expected.patches);
            if (!matches) {
              console.log("Expected patches:", JSON.stringify(testCase.expected.patches, null, 2));
              console.log("Actual patches:", JSON.stringify(collectedPatches, null, 2));
            }
            expect(matches).toBe(true);
          }
          return;
        }

        // Multi-step test case
        if (testCase.steps) {
          for (const step of testCase.steps) {
            collectedPatches = []; // Reset for each step

            switch (step.action) {
              case "initialRender":
                engine.renderSource(testCase.input.source);
                break;

              case "updateState":
                if (step.stateChange) {
                  // Update our local state
                  for (const [path, value] of Object.entries(step.stateChange.newValues)) {
                    setNestedValue(currentState, path, value);
                  }
                  engine.updateStateSparse(null, step.stateChange.paths, step.stateChange.newValues);
                }
                break;

              case "dispatchAction":
                if (step.dispatchAction) {
                  engine.dispatchAction(step.dispatchAction.name, step.dispatchAction.payload);
                  // Allow async action handlers to complete
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
                break;
            }

            // Verify expected patch count
            if (step.expectedPatchCount !== undefined) {
              expect(collectedPatches.length).toBe(step.expectedPatchCount);
            }

            // Verify expected patch types
            if (step.expectedPatchTypes) {
              const actualTypes = collectedPatches.map((p) => p.type);
              expect(actualTypes).toEqual(step.expectedPatchTypes);
            }

            // Verify expected patches (structural match)
            if (step.expectedPatches) {
              const matches = matchPatchStructure(collectedPatches, step.expectedPatches);
              if (!matches) {
                console.log("Step:", step.description || step.action);
                console.log("Expected patches:", JSON.stringify(step.expectedPatches, null, 2));
                console.log("Actual patches:", JSON.stringify(collectedPatches, null, 2));
              }
              expect(matches).toBe(true);
            }

            // Verify forbidden patch types
            if (step.forbiddenPatchTypes) {
              const actualTypes = collectedPatches.map((p) => p.type);
              for (const forbidden of step.forbiddenPatchTypes) {
                expect(actualTypes).not.toContain(forbidden);
              }
            }

            // Verify expected state
            if (step.expectedState) {
              for (const [key, expectedValue] of Object.entries(step.expectedState)) {
                expect(currentState[key]).toEqual(expectedValue);
              }
            }
          }
        }
      });
    });
  }
});

// Helper to set nested value by dot-notation path
function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}
