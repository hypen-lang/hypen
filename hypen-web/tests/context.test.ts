import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import { HypenGlobalContext } from "../packages/core/src/context";
import { app } from "../packages/core/src/app";
import type { HypenModuleInstance } from "../packages/core/src/app";
import { setLogLevel } from "../packages/core/src/logger";

// Mock engine for testing
class FakeEngine {
  setModule() {}
  registerModule() {}
  updateStateSparse() {}
  onAction() {}
}

describe("HypenGlobalContext", () => {
  let context: HypenGlobalContext;

  beforeEach(() => {
    context = new HypenGlobalContext();
  });

  describe("module registration", () => {
    test("registers a module with an ID", () => {
      const engine = new FakeEngine();
      const definition = app.defineState({ count: 0 }).build();
      const instance = new (class {
        getLiveState() {
          return { count: 0 };
        }
        getState() {
          return { count: 0 };
        }
        updateState() {}
      })() as any;

      context.registerModule("counter", instance);

      expect(context.hasModule("counter")).toBe(true);
      expect(context.getModuleIds()).toContain("counter");
    });

    test("warns when overwriting existing module", () => {
      const instance1 = {
        getLiveState: () => ({ version: 1 }),
        getState: () => ({ version: 1 }),
        updateState: () => {},
      } as any;

      const instance2 = {
        getLiveState: () => ({ version: 2 }),
        getState: () => ({ version: 2 }),
        updateState: () => {},
      } as any;

      const warnSpy = spyOn(console, "warn");

      context.registerModule("test", instance1);
      context.registerModule("test", instance2);

      expect(warnSpy).toHaveBeenCalled();
      expect(context.getModule("test").getState()).toEqual({ version: 2 });

      warnSpy.mockRestore();
    });

    test("unregisters a module", () => {
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("test", instance);
      expect(context.hasModule("test")).toBe(true);

      context.unregisterModule("test");
      expect(context.hasModule("test")).toBe(false);
    });

    test("unregistering non-existent module is safe", () => {
      expect(() => context.unregisterModule("nonexistent")).not.toThrow();
    });
  });

  describe("getModule", () => {
    test("returns module reference with state access", () => {
      const instance = {
        getLiveState: () => ({ count: 42 }),
        getState: () => ({ count: 42 }),
        updateState: mock(() => {}),
      } as any;

      context.registerModule("counter", instance);
      const ref = context.getModule("counter");

      expect(ref.state).toEqual({ count: 42 });
      expect(ref.getState()).toEqual({ count: 42 });

      ref.setState({ count: 100 });
      expect(instance.updateState).toHaveBeenCalledWith({ count: 100 });
    });

    test("throws error for non-existent module", () => {
      expect(() => context.getModule("nonexistent")).toThrow(
        'Module "nonexistent" not found'
      );
    });

    test("error message lists available modules", () => {
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("module1", instance);
      context.registerModule("module2", instance);

      try {
        context.getModule("nonexistent");
      } catch (error: any) {
        expect(error.message).toContain("module1");
        expect(error.message).toContain("module2");
      }
    });
  });

  describe("hasModule", () => {
    test("returns true for registered module", () => {
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("test", instance);
      expect(context.hasModule("test")).toBe(true);
    });

    test("returns false for non-existent module", () => {
      expect(context.hasModule("nonexistent")).toBe(false);
    });
  });

  describe("getModuleIds", () => {
    test("returns empty array when no modules registered", () => {
      expect(context.getModuleIds()).toEqual([]);
    });

    test("returns all registered module IDs", () => {
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("module1", instance);
      context.registerModule("module2", instance);
      context.registerModule("module3", instance);

      const ids = context.getModuleIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("module1");
      expect(ids).toContain("module2");
      expect(ids).toContain("module3");
    });
  });

  describe("getGlobalState", () => {
    test("returns empty object when no modules", () => {
      expect(context.getGlobalState()).toEqual({});
    });

    test("returns state snapshot from all modules", () => {
      const instance1 = {
        getLiveState: () => ({ count: 1 }),
        getState: () => ({ count: 1 }),
        updateState: () => {},
      } as any;

      const instance2 = {
        getLiveState: () => ({ name: "test" }),
        getState: () => ({ name: "test" }),
        updateState: () => {},
      } as any;

      context.registerModule("counter", instance1);
      context.registerModule("profile", instance2);

      expect(context.getGlobalState()).toEqual({
        counter: { count: 1 },
        profile: { name: "test" },
      });
    });
  });

  describe("event bus", () => {
    describe("emit", () => {
      test("emits event to registered handlers", () => {
        const handler = mock(() => {});

        context.on("test-event", handler);
        context.emit("test-event", { data: "payload" });

        expect(handler).toHaveBeenCalledWith({ data: "payload" });
      });

      test("emits to multiple handlers", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});
        const handler3 = mock(() => {});

        context.on("test-event", handler1);
        context.on("test-event", handler2);
        context.on("test-event", handler3);

        context.emit("test-event", "payload");

        expect(handler1).toHaveBeenCalledWith("payload");
        expect(handler2).toHaveBeenCalledWith("payload");
        expect(handler3).toHaveBeenCalledWith("payload");
      });

      test("emits without payload", () => {
        const handler = mock(() => {});

        context.on("test-event", handler);
        context.emit("test-event");

        expect(handler).toHaveBeenCalledWith(undefined);
      });

      test("handles event with no listeners", () => {
        const previousLevel = "info";
        setLogLevel("debug");
        const logSpy = spyOn(console, "log");

        try {
          context.emit("nonexistent-event");

          expect(logSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("no listeners")
          );
        } finally {
          logSpy.mockRestore();
          setLogLevel(previousLevel);
        }
      });

      test("catches errors in handlers and continues", () => {
        const handler1 = mock(() => {
          throw new Error("Handler 1 error");
        });
        const handler2 = mock(() => {});

        const errorSpy = spyOn(console, "error");

        context.on("test-event", handler1);
        context.on("test-event", handler2);

        context.emit("test-event");

        expect(handler1).toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
      });

      test("emits with complex payload objects", () => {
        const handler = mock(() => {});
        const payload = {
          nested: {
            deep: {
              value: 42,
            },
          },
          array: [1, 2, 3],
        };

        context.on("test-event", handler);
        context.emit("test-event", payload);

        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    describe("on", () => {
      test("registers event handler", () => {
        const handler = mock(() => {});

        context.on("test-event", handler);
        context.emit("test-event");

        expect(handler).toHaveBeenCalled();
      });

      test("returns unsubscribe function", () => {
        const handler = mock(() => {});

        const unsubscribe = context.on("test-event", handler);

        context.emit("test-event");
        expect(handler).toHaveBeenCalledTimes(1);

        unsubscribe();

        context.emit("test-event");
        expect(handler).toHaveBeenCalledTimes(1); // Not called again
      });

      test("allows multiple subscriptions to same event", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});

        context.on("test-event", handler1);
        context.on("test-event", handler2);

        context.emit("test-event");

        expect(handler1).toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
      });

      test("allows same handler to subscribe multiple times", () => {
        const handler = mock(() => {});

        context.on("test-event", handler);
        context.on("test-event", handler);

        context.emit("test-event");

        // Should only be called once (Set deduplication)
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    describe("off", () => {
      test("removes event handler", () => {
        const handler = mock(() => {});

        context.on("test-event", handler);
        context.emit("test-event");
        expect(handler).toHaveBeenCalledTimes(1);

        context.off("test-event", handler);
        context.emit("test-event");
        expect(handler).toHaveBeenCalledTimes(1); // Not called again
      });

      test("handles removing non-existent handler", () => {
        const handler = mock(() => {});

        expect(() => context.off("test-event", handler)).not.toThrow();
      });

      test("handles removing from non-existent event", () => {
        const handler = mock(() => {});

        expect(() => context.off("nonexistent", handler)).not.toThrow();
      });

      test("only removes specified handler", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});

        context.on("test-event", handler1);
        context.on("test-event", handler2);

        context.off("test-event", handler1);
        context.emit("test-event");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
      });
    });

    describe("clearEvent", () => {
      test("removes all handlers for an event", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});

        context.on("test-event", handler1);
        context.on("test-event", handler2);

        context.clearEvent("test-event");
        context.emit("test-event");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).not.toHaveBeenCalled();
      });

      test("handles clearing non-existent event", () => {
        expect(() => context.clearEvent("nonexistent")).not.toThrow();
      });

      test("only clears specified event", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});

        context.on("event1", handler1);
        context.on("event2", handler2);

        context.clearEvent("event1");

        context.emit("event1");
        context.emit("event2");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
      });
    });

    describe("clearAllEvents", () => {
      test("removes all handlers for all events", () => {
        const handler1 = mock(() => {});
        const handler2 = mock(() => {});
        const handler3 = mock(() => {});

        context.on("event1", handler1);
        context.on("event2", handler2);
        context.on("event3", handler3);

        context.clearAllEvents();

        context.emit("event1");
        context.emit("event2");
        context.emit("event3");

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).not.toHaveBeenCalled();
        expect(handler3).not.toHaveBeenCalled();
      });

      test("handles clearing when no events registered", () => {
        expect(() => context.clearAllEvents()).not.toThrow();
      });
    });
  });

  describe("debug", () => {
    test("returns debug information", () => {
      const instance = {
        getLiveState: () => ({ count: 42 }),
        getState: () => ({ count: 42 }),
        updateState: () => {},
      } as any;

      context.registerModule("counter", instance);
      context.on("test-event", () => {});

      const debug = context.debug();

      expect(debug.modules).toContain("counter");
      expect(debug.events).toContain("test-event");
      expect(debug.state).toEqual({
        counter: { count: 42 },
      });
    });

    test("returns empty arrays when nothing registered", () => {
      const debug = context.debug();

      expect(debug.modules).toEqual([]);
      expect(debug.events).toEqual([]);
      expect(debug.state).toEqual({});
    });
  });

  describe("integration scenarios", () => {
    test("cross-module communication via event bus", () => {
      const module1State = { messages: [] as string[] };
      const module2State = { count: 0 };

      const instance1 = {
        getLiveState: () => module1State,
        getState: () => module1State,
        updateState: (patch: any) => Object.assign(module1State, patch),
      } as any;

      const instance2 = {
        getLiveState: () => module2State,
        getState: () => module2State,
        updateState: (patch: any) => Object.assign(module2State, patch),
      } as any;

      context.registerModule("logger", instance1);
      context.registerModule("counter", instance2);

      // Logger listens for increment events
      context.on("increment", (payload) => {
        const logger = context.getModule("logger");
        const state = logger.getState();
        state.messages.push(`Incremented by ${payload}`);
      });

      // Counter module emits events
      const counterRef = context.getModule("counter");
      counterRef.setState({ count: 5 });
      context.emit("increment", 5);

      const loggerState = context.getModule("logger").getState();
      expect(loggerState.messages).toContain("Incremented by 5");
    });

    test("module state isolation", () => {
      const instance1 = {
        getLiveState: () => ({ value: 1 }),
        getState: () => ({ value: 1 }),
        updateState: () => {},
      } as any;

      const instance2 = {
        getLiveState: () => ({ value: 2 }),
        getState: () => ({ value: 2 }),
        updateState: () => {},
      } as any;

      context.registerModule("module1", instance1);
      context.registerModule("module2", instance2);

      const state1 = context.getModule("module1").getState();
      const state2 = context.getModule("module2").getState();

      expect(state1.value).toBe(1);
      expect(state2.value).toBe(2);
    });

    test("unsubscribe during event emission", () => {
      let unsubscribe: (() => void) | null = null;
      const handler1 = mock(() => {
        // Unsubscribe handler2 during handler1 execution
        if (unsubscribe) unsubscribe();
      });
      const handler2 = mock(() => {});

      context.on("test-event", handler1);
      unsubscribe = context.on("test-event", handler2);

      context.emit("test-event");

      expect(handler1).toHaveBeenCalledTimes(1);
      // handler2 might or might not be called depending on iteration order
      // This tests that it doesn't crash
    });

    test("memory cleanup when module unregistered", () => {
      const instance = {
        getLiveState: () => ({}),
        getState: () => ({}),
        updateState: () => {},
      } as any;

      context.registerModule("temp", instance);
      expect(context.hasModule("temp")).toBe(true);

      context.unregisterModule("temp");
      expect(context.hasModule("temp")).toBe(false);
      expect(() => context.getModule("temp")).toThrow();
    });
  });
});
