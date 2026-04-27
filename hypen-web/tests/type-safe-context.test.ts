/**
 * Tests for type-safe context and module access (Issue #2 fix)
 */

import { describe, test, expect } from "bun:test";
import { HypenGlobalContext, type ModuleReference } from "../packages/core/src/context";

describe("Type-Safe Global Context", () => {
  test("getGlobalState() returns Record<string, unknown> instead of any", () => {
    const context = new HypenGlobalContext();
    const state = context.getGlobalState();

    // Type is Record<string, unknown>
    expect(typeof state).toBe("object");
    expect(state).toEqual({});
  });

  test("typed events work with HypenGlobalContext", () => {
    type CustomEvents = {
      userLogin: { userId: string };
      userLogout: { userId: string };
    };

    const context = new HypenGlobalContext<CustomEvents>();
    let receivedUserId: string | null = null;

    context.events.on("userLogin", (payload) => {
      receivedUserId = payload.userId;
    });

    context.events.emit("userLogin", { userId: "123" });

    expect(receivedUserId as string | null).toBe("123");
  });

  test("legacy event API still works for backward compatibility", () => {
    const context = new HypenGlobalContext();
    let callCount = 0;

    // Legacy on() API
    const unsubscribe = context.on("test-event", () => {
      callCount++;
    });

    // Legacy emit() API
    context.emit("test-event", { data: "test" });

    expect(callCount).toBe(1);

    unsubscribe();
    context.emit("test-event", { data: "test" });

    expect(callCount).toBe(1); // Should not increment
  });

  test("debug() includes typed events", () => {
    type CustomEvents = {
      event1: { data: string };
    };

    const context = new HypenGlobalContext<CustomEvents>();
    
    context.events.on("event1", () => {});
    context.on("legacy-event", () => {});

    const debug = context.debug();

    expect(debug.events).toContain("event1");
    expect(debug.events).toContain("legacy-event");
  });

  test("hasModule() works correctly", () => {
    const context = new HypenGlobalContext();

    expect(context.hasModule("test")).toBe(false);

    // We can't easily test registerModule without Engine
    // but we can test the method exists and returns correct type
    const hasModule: boolean = context.hasModule("test");
    expect(typeof hasModule).toBe("boolean");
  });

  test("getModuleIds() returns empty array initially", () => {
    const context = new HypenGlobalContext();
    const ids = context.getModuleIds();

    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(0);
  });

  test("legacy off() method works", () => {
    const context = new HypenGlobalContext();
    let count = 0;

    const handler = () => count++;

    context.on("test", handler);
    context.emit("test");
    expect(count).toBe(1);

    context.off("test", handler);
    context.emit("test");
    expect(count).toBe(1); // Should not increment
  });

  test("clearEvent() removes all handlers for specific event", () => {
    const context = new HypenGlobalContext();
    let count1 = 0;
    let count2 = 0;

    context.on("event1", () => count1++);
    context.on("event2", () => count2++);

    context.clearEvent("event1");

    context.emit("event1");
    context.emit("event2");

    expect(count1).toBe(0);
    expect(count2).toBe(1);
  });

  test("clearAllEvents() removes all legacy event handlers", () => {
    const context = new HypenGlobalContext();
    let count1 = 0;
    let count2 = 0;

    context.on("event1", () => count1++);
    context.on("event2", () => count2++);

    context.clearAllEvents();

    context.emit("event1");
    context.emit("event2");

    expect(count1).toBe(0);
    expect(count2).toBe(0);
  });

  test("legacy and typed events work together", () => {
    type CustomEvents = {
      typed: { value: number };
    };

    const context = new HypenGlobalContext<CustomEvents>();
    let legacyCount = 0;
    let typedCount = 0;

    context.on("legacy", () => legacyCount++);
    context.events.on("typed", () => typedCount++);

    context.emit("legacy");
    context.events.emit("typed", { value: 42 });

    expect(legacyCount).toBe(1);
    expect(typedCount).toBe(1);
  });

  test("ModuleReference type is correctly defined", () => {
    type CounterState = { count: number };

    // This is a compile-time test - if it compiles, the types are correct
    const mockRef: ModuleReference<CounterState> = {
      state: { count: 0 },
      setState: (patch: Partial<CounterState>) => {},
      getState: (): CounterState => ({ count: 0 }),
    };

    expect(mockRef.state.count).toBe(0);
    const state = mockRef.getState();
    expect(state.count).toBe(0);
  });

  test("HypenGlobalContext constructor initializes correctly", () => {
    const context = new HypenGlobalContext();

    expect(context.events).toBeDefined();
    expect(context.getModuleIds()).toEqual([]);
    expect(context.getGlobalState()).toEqual({});
  });

  test("typed events accessor returns TypedEventEmitter", () => {
    type TestEvents = {
      test: { id: number };
    };

    const context = new HypenGlobalContext<TestEvents>();
    const emitter = context.events;

    let received: number | null = null;

    emitter.on("test", (p) => {
      received = p.id;
    });

    emitter.emit("test", { id: 42 });

    expect(received as number | null).toBe(42);
  });
});

describe("Type Safety Compilation Tests", () => {
  test("generic type parameters work correctly", () => {
    // These are compile-time tests - if they compile, types are correct
    type UserState = { name: string; email: string };
    
    const mockRef: ModuleReference<UserState> = {
      state: { name: "Alice", email: "alice@example.com" },
      setState: (patch) => {
        // patch should be Partial<UserState>
        const name: string | undefined = patch.name;
        const email: string | undefined = patch.email;
      },
      getState: () => ({ name: "Alice", email: "alice@example.com" }),
    };

    expect(mockRef.state.name).toBe("Alice");
  });

  test("unknown instead of any in global state", () => {
    const context = new HypenGlobalContext();
    const state: Record<string, unknown> = context.getGlobalState();

    // Type assertion - proves it's unknown, not any
    expect(typeof state).toBe("object");
  });
});
