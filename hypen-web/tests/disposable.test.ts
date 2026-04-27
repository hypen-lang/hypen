import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  DisposableStack,
  disposableTimeout,
  disposableInterval,
  disposableListener,
  disposableSubscription,
  disposableWebSocket,
  getElementDisposables,
  type Disposable,
} from "../packages/core/src/disposable";

describe("Disposable Pattern", () => {
  describe("DisposableStack", () => {
    test("adds and disposes resources in LIFO order", () => {
      const order: number[] = [];
      const stack = new DisposableStack();

      stack.add({ dispose: () => order.push(1) });
      stack.add({ dispose: () => order.push(2) });
      stack.add({ dispose: () => order.push(3) });

      stack.dispose();

      expect(order).toEqual([3, 2, 1]);
    });

    test("returns added disposable for chaining", () => {
      const stack = new DisposableStack();
      const disposable = { dispose: () => {} };

      const returned = stack.add(disposable);

      expect(returned).toBe(disposable);
    });

    test("addCallback creates disposable from function", () => {
      const fn = mock(() => {});
      const stack = new DisposableStack();

      stack.addCallback(fn);
      expect(fn).not.toHaveBeenCalled();

      stack.dispose();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("clears stack after dispose", () => {
      const fn = mock(() => {});
      const stack = new DisposableStack();

      stack.add({ dispose: fn });
      stack.dispose();
      stack.dispose(); // Second dispose should be no-op

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("handles errors during dispose gracefully", () => {
      const order: number[] = [];
      const stack = new DisposableStack();

      stack.add({ dispose: () => order.push(1) });
      stack.add({
        dispose: () => {
          throw new Error("dispose error");
        },
      });
      stack.add({ dispose: () => order.push(3) });

      // Should not throw, but continue disposing other resources
      expect(() => stack.dispose()).not.toThrow();

      // All disposables should still be called
      expect(order).toEqual([3, 1]);
    });

    test("size returns number of disposables", () => {
      const stack = new DisposableStack();
      expect(stack.size).toBe(0);

      stack.add({ dispose: () => {} });
      expect(stack.size).toBe(1);

      stack.add({ dispose: () => {} });
      expect(stack.size).toBe(2);

      stack.dispose();
      expect(stack.size).toBe(0);
    });

    test("isDisposed returns true after dispose", () => {
      const stack = new DisposableStack();
      expect(stack.isDisposed).toBe(false);

      stack.dispose();
      expect(stack.isDisposed).toBe(true);
    });
  });

  describe("disposableTimeout", () => {
    test("creates disposable that clears timeout on dispose", async () => {
      const fn = mock(() => {});

      const disposable = disposableTimeout(fn, 50);
      disposable.dispose();

      // Wait past the timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fn).not.toHaveBeenCalled();
    });

    test("callback executes if not disposed", async () => {
      const fn = mock(() => {});

      disposableTimeout(fn, 10);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("disposableInterval", () => {
    test("creates disposable that clears interval on dispose", async () => {
      const fn = mock(() => {});

      const disposable = disposableInterval(fn, 20);

      // Let it tick once
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);

      const callCount = fn.mock.calls.length;
      disposable.dispose();

      // Wait to ensure no more calls
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fn.mock.calls.length).toBe(callCount);
    });
  });

  describe("disposableListener", () => {
    test("adds and removes event listener", () => {
      const target = new EventTarget();
      const handler = mock(() => {});

      const disposable = disposableListener(target, "test", handler);

      target.dispatchEvent(new Event("test"));
      expect(handler).toHaveBeenCalledTimes(1);

      disposable.dispose();

      target.dispatchEvent(new Event("test"));
      expect(handler).toHaveBeenCalledTimes(1); // No new calls
    });

    test("respects addEventListener options", () => {
      const target = new EventTarget();
      const handler = mock(() => {});

      const disposable = disposableListener(target, "test", handler, {
        once: true,
      });

      target.dispatchEvent(new Event("test"));
      expect(handler).toHaveBeenCalledTimes(1);

      // With once: true, should auto-remove
      target.dispatchEvent(new Event("test"));
      expect(handler).toHaveBeenCalledTimes(1);

      // Dispose should be safe even after auto-removal
      expect(() => disposable.dispose()).not.toThrow();
    });

    test("works with DOM elements", () => {
      // Create a mock DOM element
      const element = {
        listeners: new Map<string, Set<EventListener>>(),
        addEventListener(type: string, listener: EventListener) {
          if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
          }
          this.listeners.get(type)!.add(listener);
        },
        removeEventListener(type: string, listener: EventListener) {
          this.listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event: { type: string }) {
          this.listeners.get(event.type)?.forEach((l) => l(event as Event));
        },
      } as unknown as EventTarget;

      const handler = mock(() => {});
      const disposable = disposableListener(element, "click", handler);

      (element as any).dispatchEvent({ type: "click" });
      expect(handler).toHaveBeenCalledTimes(1);

      disposable.dispose();

      (element as any).dispatchEvent({ type: "click" });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("disposableSubscription", () => {
    test("creates disposable from unsubscribe function", () => {
      const unsubscribe = mock(() => {});

      const disposable = disposableSubscription(unsubscribe);
      expect(unsubscribe).not.toHaveBeenCalled();

      disposable.dispose();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    test("can be called multiple times (idempotency depends on callback)", () => {
      let callCount = 0;
      const unsubscribe = () => callCount++;

      const disposable = disposableSubscription(unsubscribe);
      disposable.dispose();
      disposable.dispose();

      // Unlike DisposableStack, individual disposables don't track disposal
      expect(callCount).toBe(2);
    });
  });

  describe("disposableWebSocket", () => {
    test("closes WebSocket on dispose", () => {
      const mockWs = {
        readyState: 1, // OPEN
        close: mock(() => {}),
        OPEN: 1,
        CONNECTING: 0,
      } as unknown as WebSocket;

      const disposable = disposableWebSocket(mockWs);
      disposable.dispose();

      expect((mockWs.close as any).mock.calls.length).toBe(1);
    });

    test("handles already closed WebSocket", () => {
      const mockWs = {
        readyState: 3, // CLOSED
        close: mock(() => {}),
        OPEN: 1,
        CONNECTING: 0,
      } as unknown as WebSocket;

      const disposable = disposableWebSocket(mockWs);

      expect(() => disposable.dispose()).not.toThrow();
      expect((mockWs.close as any).mock.calls.length).toBe(0);
    });

    test("closes connecting WebSocket", () => {
      const mockWs = {
        readyState: 0, // CONNECTING
        close: mock(() => {}),
        OPEN: 1,
        CONNECTING: 0,
      } as unknown as WebSocket;

      const disposable = disposableWebSocket(mockWs);
      disposable.dispose();

      expect((mockWs.close as any).mock.calls.length).toBe(1);
    });
  });

  describe("getElementDisposables", () => {
    test("returns same DisposableStack for same element", () => {
      const element = {} as HTMLElement;

      const stack1 = getElementDisposables(element);
      const stack2 = getElementDisposables(element);

      expect(stack1).toBe(stack2);
    });

    test("returns different stacks for different elements", () => {
      const element1 = {} as HTMLElement;
      const element2 = {} as HTMLElement;

      const stack1 = getElementDisposables(element1);
      const stack2 = getElementDisposables(element2);

      expect(stack1).not.toBe(stack2);
    });

    test("disposes resources when element stack is disposed", () => {
      const element = {} as HTMLElement;
      const fn = mock(() => {});

      const stack = getElementDisposables(element);
      stack.addCallback(fn);

      stack.dispose();

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Integration: DisposableStack with utilities", () => {
    test("manages multiple resource types", async () => {
      const stack = new DisposableStack();
      const target = new EventTarget();

      const timeoutFn = mock(() => {});
      const listenerFn = mock(() => {});
      const cleanupFn = mock(() => {});

      stack.add(disposableTimeout(timeoutFn, 100));
      stack.add(disposableListener(target, "test", listenerFn));
      stack.addCallback(cleanupFn);

      // Trigger event before dispose
      target.dispatchEvent(new Event("test"));
      expect(listenerFn).toHaveBeenCalledTimes(1);

      // Dispose all
      stack.dispose();

      // Event listener should be removed
      target.dispatchEvent(new Event("test"));
      expect(listenerFn).toHaveBeenCalledTimes(1);

      // Cleanup should have been called
      expect(cleanupFn).toHaveBeenCalledTimes(1);

      // Timeout should not fire
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(timeoutFn).not.toHaveBeenCalled();
    });
  });
});
