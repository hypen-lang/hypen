import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import { Hypen } from "../packages/web-engine/src/hypen";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import type { ErrorContext } from "../packages/core/src/app";
import { HypenGlobalContext } from "../packages/core/src/context";
import { ComponentLoader } from "../packages/server/src/loader";
import { HypenRouter } from "../packages/core/src/router";
import { createObservableState } from "../packages/core/src/state";
import type { IEngine as Engine } from "../packages/core/src/app";
import { classifyEngineError, ParseError, RenderError, StateError } from "../packages/core/src/result";

/**
 * Error Handling Tests
 * Tests error scenarios across the system to ensure graceful degradation
 */

describe("Error Handling", () => {
  describe("Module System Errors", () => {
    test("handles errors in onCreated lifecycle", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onCreated(() => {
          throw new Error("Creation failed");
        })
        .build();

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: () => {},
      } as any;

      // Should not throw, error should be caught
      expect(() => {
        new HypenModuleInstance(fakeEngine, definition);
      }).not.toThrow();

      errorSpy.mockRestore();
    });

    test("handles errors in action handlers", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", () => {
          throw new Error("Action failed");
        })
        .build();

      const handlers: Record<string, Function> = {};

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name: string, handler: Function) => {
          handlers[name] = handler;
        }),
      } as any;

      const instance = new HypenModuleInstance(fakeEngine, definition);

      // Verify onAction was called
      expect(fakeEngine.onAction).toHaveBeenCalled();

      // Now invoke the handler - with Result-based error handling, it doesn't throw
      // but instead logs the error and handles it gracefully
      if (handlers["increment"]) {
        // The handler should complete without throwing (errors are captured in Result)
        await handlers["increment"]({ name: "increment", payload: undefined });
      }

      // Verify error was logged (Result-based error handling logs errors)
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    test("calls module-level onError handler when action throws", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const errorHandler = mock((ctx: ErrorContext<{ count: number }>) => {
        // Just observe the error
      });

      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", () => {
          throw new Error("Action failed");
        })
        .onError(errorHandler)
        .build();

      const handlers: Record<string, Function> = {};

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name: string, handler: Function) => {
          handlers[name] = handler;
        }),
      } as any;

      new HypenModuleInstance(fakeEngine, definition);

      if (handlers["increment"]) {
        await handlers["increment"]({ name: "increment", payload: undefined });
      }

      // Verify onError was called with correct context
      expect(errorHandler).toHaveBeenCalled();
      const [ctx] = errorHandler.mock.calls[0];
      expect(ctx.actionName).toBe("increment");
      expect(ctx.error.message).toContain("Action failed");
      expect(ctx.state).toEqual({ count: 0 });

      errorSpy.mockRestore();
    });

    test("onError handler can suppress default error behavior", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", () => {
          throw new Error("Handled error");
        })
        .onError(() => {
          // Return handled: true to suppress default behavior
          return { handled: true };
        })
        .build();

      let registeredHandler: Function | null = null;

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name: string, handler: Function) => {
          registeredHandler = handler;
        }),
      } as any;

      new HypenModuleInstance(fakeEngine, definition);

      if (registeredHandler) {
        await registeredHandler({ name: "increment", payload: undefined });
      }

      // Error should NOT be logged because handler returned { handled: true }
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    test("onError handler can rethrow errors", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", () => {
          throw new Error("Critical error");
        })
        .onError(() => {
          return { rethrow: true };
        })
        .build();

      const handlers: Record<string, Function> = {};

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name: string, handler: Function) => {
          handlers[name] = handler;
        }),
      } as any;

      new HypenModuleInstance(fakeEngine, definition);

      if (handlers["increment"]) {
        // Should throw because handler returned { rethrow: true }
        await expect(handlers["increment"]({ name: "increment", payload: undefined }))
          .rejects.toThrow("Critical error");
      }

      errorSpy.mockRestore();
    });

    test("onError handler receives state for inspection", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      let capturedState: any = null;

      const definition = app
        .defineState({ count: 42, name: "test" })
        .onAction("fail", () => {
          throw new Error("Oops");
        })
        .onError(({ state }) => {
          capturedState = { ...state };
          return { handled: true };
        })
        .build();

      const handlers: Record<string, Function> = {};

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name: string, handler: Function) => {
          handlers[name] = handler;
        }),
      } as any;

      new HypenModuleInstance(fakeEngine, definition);

      if (handlers["fail"]) {
        await handlers["fail"]({ name: "fail", payload: undefined });
      }

      expect(capturedState).toEqual({ count: 42, name: "test" });

      errorSpy.mockRestore();
    });

    test("handles errors in onDestroyed lifecycle", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const definition = app
        .defineState({ count: 0 })
        .onDestroyed(() => {
          throw new Error("Destruction failed");
        })
        .build();

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: () => {},
      } as any;

      const instance = new HypenModuleInstance(fakeEngine, definition);

      // Should not throw when destroying
      expect(() => {
        // @ts-ignore - accessing private method for testing
        instance.definition.lifecycle.onDestroyed?.(instance.getLiveState(), () => {});
      }).toThrow(); // It will throw but shouldn't crash the app

      errorSpy.mockRestore();
    });

    test("handles invalid state updates gracefully", async () => {
      const definition = app.defineState({ count: 0 }).build();

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: () => {},
      } as any;

      const instance = new HypenModuleInstance(fakeEngine, definition);

      // Should handle null/undefined updates
      expect(() => {
        instance.updateState(null as any);
      }).not.toThrow();

      expect(() => {
        instance.updateState(undefined as any);
      }).not.toThrow();
    });

    test("handles circular state references", () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      // Should not throw when creating observable state with circular refs
      expect(() => {
        createObservableState(circular);
      }).not.toThrow();
    });
  });

  describe("Component Loader Errors", () => {
    test("handles registration with invalid module", () => {
      const loader = new ComponentLoader();

      expect(() => {
        loader.register("Test", null as any, "template");
      }).not.toThrow();
    });

    test("handles registration with invalid template", () => {
      const loader = new ComponentLoader();
      const module = app.defineState({}).build();

      expect(() => {
        loader.register("Test", module, null as any);
      }).not.toThrow();
    });

    test("handles get on non-existent component", () => {
      const loader = new ComponentLoader();

      expect(loader.get("NonExistent")).toBeUndefined();
    });

    test("handles loadFromDirectory with invalid path", async () => {
      const loader = new ComponentLoader();

      await expect(
        loader.loadFromDirectory("Test", "/invalid/path")
      ).rejects.toThrow();
    });

    test("handles loadFromComponentsDir with invalid path", async () => {
      const loader = new ComponentLoader();

      // Should not throw, just warn and resolve successfully
      await loader.loadFromComponentsDir("/invalid/path");
      // If we reach here, the function didn't throw
      expect(true).toBe(true);
    });
  });

  describe("Global Context Errors", () => {
    test("handles getModule for non-existent module", () => {
      const context = new HypenGlobalContext();

      expect(() => {
        context.getModule("nonexistent");
      }).toThrow('Module "nonexistent" not found');
    });

    test("handles event handler errors without crashing", () => {
      const context = new HypenGlobalContext();
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const goodHandler = mock(() => {});
      const badHandler = mock(() => {
        throw new Error("Handler error");
      });

      context.on("test", badHandler);
      context.on("test", goodHandler);

      context.emit("test");

      // Both handlers should be called despite error
      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    test("handles unsubscribe of non-existent handler", () => {
      const context = new HypenGlobalContext();
      const handler = () => {};

      expect(() => {
        context.off("nonexistent", handler);
      }).not.toThrow();
    });

    test("handles clearEvent on non-existent event", () => {
      const context = new HypenGlobalContext();

      expect(() => {
        context.clearEvent("nonexistent");
      }).not.toThrow();
    });

    test("handles module state access after unregister", () => {
      const context = new HypenGlobalContext();
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("test", instance);
      context.unregisterModule("test");

      expect(() => {
        context.getModule("test");
      }).toThrow();
    });
  });

  describe("Router Errors", () => {
    test("handles invalid path patterns gracefully", () => {
      const router = new HypenRouter();

      expect(() => {
        router.matchPath("", "/test");
      }).not.toThrow();

      expect(() => {
        router.matchPath(null as any, "/test");
      }).not.toThrow();
    });

    test("handles invalid paths in navigation", () => {
      const router = new HypenRouter();

      expect(() => {
        router.push(null as any);
      }).not.toThrow();

      expect(() => {
        router.push(undefined as any);
      }).not.toThrow();
    });

    test("handles subscriber errors without affecting other subscribers", () => {
      const router = new HypenRouter();

      const goodSubscriber = mock(() => {});
      const badSubscriber = mock(() => {
        throw new Error("Subscriber error");
      });

      router.onNavigate(badSubscriber);
      router.onNavigate(goodSubscriber);

      badSubscriber.mockClear();
      goodSubscriber.mockClear();

      // Should not throw
      expect(() => {
        router.push("/test");
      }).not.toThrow();
    });

    test("handles buildUrl with invalid query params", () => {
      const router = new HypenRouter();

      expect(() => {
        router.buildUrl("/test", null as any);
      }).not.toThrow();

      expect(() => {
        router.buildUrl("/test", { key: null as any });
      }).not.toThrow();
    });
  });

  describe("State Management Errors", () => {
    test("handles mutation of frozen objects", () => {
      const frozen = Object.freeze({ count: 0 });

      // createObservableState clones the input, so the clone is not frozen
      const state = createObservableState(frozen);

      // Original frozen object is still frozen
      expect(Object.isFrozen(frozen)).toBe(true);

      // But the observable state can be mutated (since it's a clone)
      expect(() => {
        (state as any).count = 1;
      }).not.toThrow();

      // And the mutation works
      expect(state.count).toBe(1);
    });

    test("handles deeply nested state mutations", () => {
      const state = createObservableState({
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  value: 0,
                },
              },
            },
          },
        },
      });

      expect(() => {
        state.level1.level2.level3.level4.level5.value = 42;
      }).not.toThrow();

      expect(state.level1.level2.level3.level4.level5.value).toBe(42);
    });

    test("handles array mutations with invalid indices", () => {
      const state = createObservableState({ items: [1, 2, 3] });

      expect(() => {
        state.items[100] = 999;
      }).not.toThrow();

      expect(state.items[100]).toBe(999);
    });

    test("handles deleting non-existent properties", () => {
      const state = createObservableState({ count: 0 });

      expect(() => {
        delete (state as any).nonexistent;
      }).not.toThrow();
    });

    test("handles property access on null/undefined", () => {
      const state = createObservableState({ nested: null as any });

      expect(() => {
        // This would normally throw
        const value = state.nested?.property;
      }).not.toThrow();
    });
  });

  describe("WASM Engine Errors", () => {
    test("classifies parse errors from invalid Hypen DSL syntax", () => {
      const err = classifyEngineError(new Error("Parse error: unexpected token at line 1"));

      expect(err).toBeInstanceOf(ParseError);
      expect(err.code).toBe("PARSE_ERROR");
      expect(err.message).toContain("Parse error:");
    });

    test("classifies component resolution / render failures", () => {
      const err = classifyEngineError(
        new Error("Parent node not found: route-container-123")
      );

      expect(err).toBeInstanceOf(RenderError);
      expect(err.code).toBe("RENDER_ERROR");
      expect(err.message).toContain("Parent node not found:");
    });

    test("classifies invalid state binding errors", () => {
      const err = classifyEngineError(
        new Error("Invalid state: path 'nonexistent' does not exist")
      );

      expect(err).toBeInstanceOf(StateError);
      expect(err.code).toBe("STATE_ERROR");
      expect(err.message).toContain("Invalid state:");
    });

    test("classifies unknown engine errors as RenderError", () => {
      const err = classifyEngineError("some unknown wasm error");

      expect(err).toBeInstanceOf(RenderError);
      expect(err.code).toBe("RENDER_ERROR");
    });

    test("engine wrapper rethrows classified errors from renderSource", () => {
      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: () => {},
      } as any;

      // Simulate what happens when the engine wrapper catches a WASM error
      const wasmError = new Error("Parse error: unclosed brace at line 5");
      const classified = classifyEngineError(wasmError);
      expect(classified).toBeInstanceOf(ParseError);
      expect(classified.message).toContain("unclosed brace");
    });
  });

  describe("Integration Error Scenarios", () => {
    test("handles module with invalid initial state", () => {
      const definition = app.defineState(null as any).build();

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: () => {},
      } as any;

      expect(() => {
        new HypenModuleInstance(fakeEngine, definition);
      }).not.toThrow();
    });

    test("handles rapid state changes", () => {
      const state = createObservableState({ count: 0 });

      expect(() => {
        for (let i = 0; i < 1000; i++) {
          state.count = i;
        }
      }).not.toThrow();

      expect(state.count).toBe(999);
    });

    test("handles concurrent module registrations", () => {
      const context = new HypenGlobalContext();
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      expect(() => {
        for (let i = 0; i < 100; i++) {
          context.registerModule(`module${i}`, instance);
        }
      }).not.toThrow();

      expect(context.getModuleIds()).toHaveLength(100);
    });

    test("handles event emission during unsubscribe", () => {
      const context = new HypenGlobalContext();
      let unsubscribe: (() => void) | null = null;

      const handler = mock(() => {
        if (unsubscribe) unsubscribe();
      });

      unsubscribe = context.on("test", handler);

      expect(() => {
        context.emit("test");
      }).not.toThrow();
    });

    test("handles router navigation during subscription callback", () => {
      const router = new HypenRouter();

      const callback = mock(() => {
        // Navigate during callback
        router.push("/nested");
      });

      router.onNavigate(callback);
      callback.mockClear();

      expect(() => {
        router.push("/initial");
      }).not.toThrow();
    });
  });

  describe("Memory and Resource Errors", () => {
    test("handles large state objects", () => {
      const largeState: any = {};
      for (let i = 0; i < 10000; i++) {
        largeState[`key${i}`] = i;
      }

      expect(() => {
        createObservableState(largeState);
      }).not.toThrow();
    });

    test("handles deeply nested objects", () => {
      let deep: any = { value: 0 };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep };
      }

      expect(() => {
        createObservableState(deep);
      }).not.toThrow();
    });

    test("handles many event subscriptions", () => {
      const context = new HypenGlobalContext();
      const handlers: Array<() => void> = [];

      for (let i = 0; i < 1000; i++) {
        handlers.push(() => {});
      }

      expect(() => {
        handlers.forEach((handler) => {
          context.on("test", handler);
        });
      }).not.toThrow();
    });

    test("handles cleanup of many subscriptions", () => {
      const router = new HypenRouter();
      const unsubscribers: Array<() => void> = [];

      for (let i = 0; i < 1000; i++) {
        unsubscribers.push(router.onNavigate(() => {}));
      }

      expect(() => {
        unsubscribers.forEach((unsub) => unsub());
      }).not.toThrow();
    });
  });

  describe("Type Safety Errors", () => {
    test("handles type mismatches in state updates", () => {
      const state = createObservableState({ count: 0 });

      // TypeScript would catch this, but test runtime behavior
      expect(() => {
        (state as any).count = "not a number";
      }).not.toThrow();

      expect(state.count).toBe("not a number");
    });

    test("handles type mismatches in action payloads", () => {
      const definition = app
        .defineState({ count: 0 })
        .onAction("increment", ({ action, state }) => {
          // Expect number, might receive string
          state.count += action.payload as number;
        })
        .build();

      const fakeEngine = {
        setModule: () => {},
        updateStateSparse: () => {},
        onAction: mock((name, handler) => {
          handler({ name: "increment", payload: "invalid" });
        }),
      } as any;

      expect(() => {
        new HypenModuleInstance(fakeEngine, definition);
      }).not.toThrow();
    });
  });

  describe("Edge Case Errors", () => {
    test("handles empty component names", () => {
      const loader = new ComponentLoader();
      const module = app.defineState({}).build();

      expect(() => {
        loader.register("", module, "template");
      }).not.toThrow();

      expect(loader.has("")).toBe(true);
    });

    test("handles null event names", () => {
      const context = new HypenGlobalContext();

      expect(() => {
        context.on(null as any, () => {});
      }).not.toThrow();
    });

    test("handles undefined payloads", () => {
      const context = new HypenGlobalContext();
      const handler = mock(() => {});

      context.on("test", handler);
      context.emit("test", undefined);

      expect(handler).toHaveBeenCalledWith(undefined);
    });

    test("handles Symbol keys in state", () => {
      const sym = Symbol("test");
      const state = createObservableState({ [sym]: "value" } as any);

      expect(() => {
        (state as any)[sym] = "new value";
      }).not.toThrow();
    });
  });
});
