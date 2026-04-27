/**
 * Tests for TypedEventEmitter (Issue #4 fix)
 */

import { describe, test, expect } from "bun:test";
import { TypedEventEmitter, createEventEmitter, type HypenFrameworkEvents } from "../packages/core/src/events";

describe("TypedEventEmitter", () => {
  test("emits and receives typed events", () => {
    type TestEvents = {
      userLogin: { userId: string; username: string };
      userLogout: { userId: string };
    };

    const emitter = new TypedEventEmitter<TestEvents>();
    let received: { userId: string; username: string } | null = null;

    emitter.on("userLogin", (payload) => {
      received = payload;
    });

    emitter.emit("userLogin", { userId: "123", username: "alice" });

    expect(received).toEqual({ userId: "123", username: "alice" });
  });

  test("supports multiple listeners for same event", () => {
    type TestEvents = {
      testEvent: { count: number };
    };

    const emitter = new TypedEventEmitter<TestEvents>();
    const calls: number[] = [];

    emitter.on("testEvent", (p) => calls.push(p.count));
    emitter.on("testEvent", (p) => calls.push(p.count * 2));

    emitter.emit("testEvent", { count: 5 });

    expect(calls).toEqual([5, 10]);
  });

  test("unsubscribe works correctly", () => {
    type TestEvents = {
      testEvent: { value: string };
    };

    const emitter = new TypedEventEmitter<TestEvents>();
    let callCount = 0;

    const unsubscribe = emitter.on("testEvent", () => {
      callCount++;
    });

    emitter.emit("testEvent", { value: "test" });
    expect(callCount).toBe(1);

    unsubscribe();
    emitter.emit("testEvent", { value: "test" });
    expect(callCount).toBe(1); // Should not increment
  });

  test("once() auto-unsubscribes after first emit", () => {
    type TestEvents = {
      testEvent: { id: number };
    };

    const emitter = new TypedEventEmitter<TestEvents>();
    let callCount = 0;

    emitter.once("testEvent", () => {
      callCount++;
    });

    emitter.emit("testEvent", { id: 1 });
    emitter.emit("testEvent", { id: 2 });
    emitter.emit("testEvent", { id: 3 });

    expect(callCount).toBe(1);
  });

  test("listenerCount() returns correct count", () => {
    type TestEvents = {
      testEvent: { id: number };
    };

    const emitter = new TypedEventEmitter<TestEvents>();

    expect(emitter.listenerCount("testEvent")).toBe(0);

    emitter.on("testEvent", () => {});
    expect(emitter.listenerCount("testEvent")).toBe(1);

    emitter.on("testEvent", () => {});
    expect(emitter.listenerCount("testEvent")).toBe(2);
  });

  test("works with HypenFrameworkEvents", () => {
    const emitter = new TypedEventEmitter<HypenFrameworkEvents>();
    let moduleId: string | null = null;

    emitter.on("module:created", (payload) => {
      moduleId = payload.moduleId;
    });

    emitter.emit("module:created", { moduleId: "TestModule" });

    expect(moduleId).toBe("TestModule");
  });
});
