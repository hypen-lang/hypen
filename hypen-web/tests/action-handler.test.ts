/**
 * Tests for new ActionHandler context-based API (Issue #3 fix)
 */

import { describe, test, expect } from "bun:test";
import { app, type ActionHandlerContext, type ActionContext } from "../packages/core/src/app";

describe("ActionHandler Context API", () => {
  test("modern handler receives all context in single parameter", async () => {
    let receivedContext: ActionHandlerContext<{ count: number }> | null = null;

    const module = app
      .defineState({ count: 0 })
      .onAction("test", (ctx) => {
        receivedContext = ctx;
        ctx.state.count++;
      })
      .build();

    // Verify handler is registered
    const handler = module.handlers.onAction.get("test")!;
    expect(handler).toBeDefined();

    // Mock context for testing
    const mockContext: ActionHandlerContext<{ count: number }> = {
      action: { name: "test", payload: undefined },
      state: { count: 0 },
      context: null as any,
    };

    await handler(mockContext);

    expect(receivedContext).not.toBeNull();
    expect(receivedContext?.action.name).toBe("test");
    expect(mockContext.state.count).toBe(1);
  });

  test("handler can destructure only needed properties", async () => {
    let stateReceived: { count: number } | null = null;
    let actionReceived: { name: string } | null = null;

    const module = app
      .defineState({ count: 0 })
      .onAction("increment", ({ state, action }) => {
        stateReceived = state;
        actionReceived = action;
        state.count++;
      })
      .build();

    const handler = module.handlers.onAction.get("increment")!;
    const mockContext: ActionHandlerContext<{ count: number }> = {
      action: { name: "increment", payload: undefined },
      state: { count: 0 },
      context: null as any,
    };

    await handler(mockContext);

    expect(stateReceived).toEqual({ count: 1 });
    expect(actionReceived?.name).toBe("increment");
  });

  test("handler receives payload correctly", async () => {
    let receivedPayload: { amount: number } | null = null;

    const module = app
      .defineState({ total: 0 })
      .onAction("add", ({ action, state }) => {
        receivedPayload = action.payload as { amount: number };
        state.total += receivedPayload.amount;
      })
      .build();

    const handler = module.handlers.onAction.get("add")!;
    const mockContext: ActionHandlerContext<{ total: number }> = {
      action: { name: "add", payload: { amount: 5 } },
      state: { total: 10 },
      context: null as any,
    };

    await handler(mockContext);

    expect(receivedPayload).toEqual({ amount: 5 });
    expect(mockContext.state.total).toBe(15);
  });

  test("async handler works correctly", async () => {
    const module = app
      .defineState({ data: null as string | null })
      .onAction("fetch", async ({ state }) => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.data = "loaded";
      })
      .build();

    const handler = module.handlers.onAction.get("fetch")!;
    const mockContext: ActionHandlerContext<{ data: string | null }> = {
      action: { name: "fetch", payload: undefined },
      state: { data: null },
      context: null as any,
    };

    await handler(mockContext);

    expect(mockContext.state.data).toBe("loaded");
  });

  test("multiple actions can be registered", () => {
    const module = app
      .defineState({ count: 0 })
      .onAction("increment", ({ state }) => {
        state.count++;
      })
      .onAction("decrement", ({ state }) => {
        state.count--;
      })
      .onAction("reset", ({ state }) => {
        state.count = 0;
      })
      .build();

    expect(module.actions).toContain("increment");
    expect(module.actions).toContain("decrement");
    expect(module.actions).toContain("reset");
    expect(module.actions.length).toBe(3);
  });

  test("handler with error handling", async () => {
    let errorCaught = false;

    const module = app
      .defineState({ value: 0 })
      .onAction("failing", () => {
        throw new Error("Test error");
      })
      .build();

    const handler = module.handlers.onAction.get("failing")!;
    const mockContext: ActionHandlerContext<{ value: number }> = {
      action: { name: "failing", payload: undefined },
      state: { value: 0 },
      context: null as any,
    };

    try {
      await handler(mockContext);
    } catch (error) {
      errorCaught = true;
    }

    expect(errorCaught).toBe(true);
  });

  test("state mutations are preserved", async () => {
    const module = app
      .defineState({ items: [] as string[], count: 0 })
      .onAction("addItem", ({ state, action }) => {
        const item = action.payload as string;
        state.items.push(item);
        state.count++;
      })
      .build();

    const handler = module.handlers.onAction.get("addItem")!;
    const state = { items: [] as string[], count: 0 };
    
    const mockContext: ActionHandlerContext<typeof state> = {
      action: { name: "addItem", payload: "test-item" },
      state,
      context: null as any,
    };

    await handler(mockContext);

    expect(state.items).toEqual(["test-item"]);
    expect(state.count).toBe(1);
  });
});

describe("Module Definition Type Safety", () => {
  test("HypenModuleDefinition is typed with state", () => {
    type UserState = { name: string; email: string };

    const module = app
      .defineState<UserState>({ name: "", email: "" })
      .onAction("updateName", ({ state, action }) => {
        state.name = action.payload as string;
      })
      .build();

    // Type assertions to verify compilation
    const state: UserState = module.initialState;
    expect(state.name).toBe("");
    expect(state.email).toBe("");
  });

  test("stateKeys extraction is safe", () => {
    // Test with object state
    const module1 = app
      .defineState({ count: 0, name: "test" })
      .build();

    expect(module1.stateKeys).toContain("count");
    expect(module1.stateKeys).toContain("name");

    // Test with null state
    const module2 = app
      .defineState(null)
      .build();

    expect(module2.stateKeys).toEqual([]);

    // Test with primitive state
    const module3 = app
      .defineState(42)
      .build();

    expect(module3.stateKeys).toEqual([]);
  });
});

describe("Typed onAction<P>", () => {
  test("typed payload generic compiles and handler receives typed action", async () => {
    type AddPayload = { amount: number };
    let receivedPayload: AddPayload | undefined;

    const module = app
      .defineState({ total: 0 })
      .onAction<AddPayload>("add", ({ action, state }) => {
        receivedPayload = action.payload;
        if (action.payload) {
          state.total += action.payload.amount;
        }
      })
      .build();

    const handler = module.handlers.onAction.get("add")!;
    expect(handler).toBeDefined();

    const mockContext: ActionHandlerContext<{ total: number }, AddPayload> = {
      action: { name: "add", payload: { amount: 7 } },
      state: { total: 10 },
      context: null as any,
    };

    await handler(mockContext);

    expect(receivedPayload).toEqual({ amount: 7 });
    expect(mockContext.state.total).toBe(17);
  });

  test("untyped onAction defaults payload to unknown", async () => {
    let receivedPayload: unknown;

    const module = app
      .defineState({ count: 0 })
      .onAction("test", ({ action }) => {
        receivedPayload = action.payload;
      })
      .build();

    const handler = module.handlers.onAction.get("test")!;

    await handler({
      action: { name: "test", payload: "hello" },
      state: { count: 0 },
      context: null as any,
    });

    expect(receivedPayload).toBe("hello");
  });

  test("ActionContext generic types payload correctly", () => {
    // Compile-time check: ActionContext<number> narrows payload type
    const ctx: ActionContext<number> = {
      name: "test",
      payload: 42,
    };
    expect(ctx.payload).toBe(42);

    // Default ActionContext has unknown payload
    const defaultCtx: ActionContext = {
      name: "test",
      payload: "anything",
    };
    expect(defaultCtx.payload).toBe("anything");
  });
});

describe("context.router", () => {
  test("ActionHandlerContext has no next property", () => {
    const ctx: ActionHandlerContext<{ count: number }> = {
      action: { name: "test" },
      state: { count: 0 },
      context: {
        getModule: () => null as any,
        hasModule: () => false,
        getModuleIds: () => [],
        getGlobalState: () => ({}),
        emit: () => {},
        on: () => () => {},
        router: null,
      },
    };

    // Verify context.router exists and next does not
    expect(ctx.context.router).toBeNull();
    expect((ctx as any).next).toBeUndefined();
  });

  test("context.router is accessible in handler", async () => {
    let routerValue: unknown = "unset";

    const module = app
      .defineState({})
      .onAction("navigate", ({ context }) => {
        routerValue = context.router;
      })
      .build();

    const handler = module.handlers.onAction.get("navigate")!;
    const mockRouter = { push: () => {} };

    await handler({
      action: { name: "navigate" },
      state: {},
      context: {
        getModule: () => null as any,
        hasModule: () => false,
        getModuleIds: () => [],
        getGlobalState: () => ({}),
        emit: () => {},
        on: () => () => {},
        router: mockRouter as any,
      },
    });

    expect(routerValue).toBe(mockRouter);
  });
});
