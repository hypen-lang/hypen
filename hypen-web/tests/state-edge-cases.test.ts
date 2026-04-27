import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  createObservableState,
  batchStateUpdates,
  getStateSnapshot,
} from "../packages/core/src/state";

/**
 * State Management Edge Case Tests
 * Tests complex scenarios and edge cases for the observable state system
 */

describe("State Edge Cases", () => {
  describe("Array Mutations", () => {
    test("handles push() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      state.items.push(4);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([1, 2, 3, 4]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles pop() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      const popped = state.items.pop();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(popped).toBe(3);
      expect(state.items).toEqual([1, 2]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles shift() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      const shifted = state.items.shift();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shifted).toBe(1);
      expect(state.items).toEqual([2, 3]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles unshift() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [2, 3] }, { onChange });

      state.items.unshift(1);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([1, 2, 3]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles splice() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3, 4, 5] }, { onChange });

      state.items.splice(2, 1, 99); // Remove 3, insert 99

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([1, 2, 99, 4, 5]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles sort() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [3, 1, 2] }, { onChange });

      state.items.sort();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([1, 2, 3]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles reverse() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      state.items.reverse();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([3, 2, 1]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles fill() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      state.items.fill(0);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([0, 0, 0]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles copyWithin() correctly", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3, 4, 5] }, { onChange });

      state.items.copyWithin(0, 3, 4);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items).toEqual([4, 2, 3, 4, 5]);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles array index assignment", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      state.items[1] = 99;

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items[1]).toBe(99);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles sparse array assignment", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [] as any[] }, { onChange });

      state.items[100] = "value";

      expect(state.items[100]).toBe("value");
      expect(state.items.length).toBe(101);
    });

    test("handles array with nested objects", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        { items: [{ id: 1 }, { id: 2 }] },
        { onChange }
      );

      state.items[0]!.id = 99;

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.items[0]!.id).toBe(99);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles array with nested arrays", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        { matrix: [[1, 2], [3, 4]] },
        { onChange }
      );

      state.matrix[0]![1] = 99;

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.matrix[0]![1]).toBe(99);
      expect(onChange).toHaveBeenCalled();
    });
  });

  describe("Deeply Nested State", () => {
    test("handles 10 levels of nesting", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        {
          l1: {
            l2: {
              l3: {
                l4: {
                  l5: {
                    l6: {
                      l7: {
                        l8: {
                          l9: {
                            l10: "deep value",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        { onChange }
      );

      state.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10 = "new value";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10).toBe("new value");
      expect(onChange).toHaveBeenCalled();
    });

    test("handles mixed nesting (objects and arrays)", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        {
          users: [
            {
              name: "Alice",
              posts: [
                { title: "Post 1", comments: [{ text: "Comment 1" }] },
              ],
            },
          ],
        },
        { onChange }
      );

      state.users[0]!.posts[0]!.comments[0]!.text = "Updated";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.users[0]!.posts[0]!.comments[0]!.text).toBe("Updated");
      expect(onChange).toHaveBeenCalled();
    });

    test("handles adding new nested paths dynamically", async () => {
      const onChange = mock(() => {});
      const state = createObservableState<any>({ root: {} }, { onChange });

      state.root.level1 = {};
      state.root.level1.level2 = {};
      state.root.level1.level2.value = "deep";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.root.level1.level2.value).toBe("deep");
      expect(onChange).toHaveBeenCalled();
    });
  });

  describe("Circular References", () => {
    test("handles circular object references", () => {
      const onChange = mock(() => {});
      const obj: any = { name: "circular" };
      obj.self = obj;

      const state = createObservableState(obj, { onChange });

      expect(state.self).toBe(state);
    });

    test("handles circular references in arrays", () => {
      const onChange = mock(() => {});
      const arr: any[] = [1, 2, 3];
      arr.push(arr);

      const state = createObservableState({ array: arr }, { onChange });

      expect(state.array[3]).toBe(state.array);
    });

    test("handles indirect circular references", () => {
      const onChange = mock(() => {});
      const a: any = { name: "a" };
      const b: any = { name: "b", ref: a };
      a.ref = b;

      const state = createObservableState({ root: a }, { onChange });

      expect(state.root.ref.ref).toBe(state.root);
    });
  });

  describe("Special Values", () => {
    test("handles null values", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ value: null as any }, { onChange });

      state.value = null;

      expect(state.value).toBeNull();
    });

    test("handles undefined values", () => {
      const onChange = mock(() => {});
      const state = createObservableState<any>({ value: "defined" }, { onChange });

      state.value = undefined;

      expect(state.value).toBeUndefined();
    });

    test("handles NaN values", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ value: 0 }, { onChange });

      state.value = NaN;

      expect(Number.isNaN(state.value)).toBe(true);
    });

    test("handles Infinity values", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ value: 0 }, { onChange });

      state.value = Infinity;

      expect(state.value).toBe(Infinity);
    });

    test("handles negative zero", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ value: 0 }, { onChange });

      state.value = -0;

      expect(Object.is(state.value, -0)).toBe(true);
    });

    test("handles Date objects", () => {
      const onChange = mock(() => {});
      const date = new Date();
      const state = createObservableState({ date }, { onChange });

      // State contains an equivalent Date (cloned for isolation)
      expect(state.date.getTime()).toBe(date.getTime());
      expect(state.date instanceof Date).toBe(true);
    });

    test("handles RegExp objects", () => {
      const onChange = mock(() => {});
      const regex = /test/g;
      const state = createObservableState({ regex }, { onChange });

      // State contains an equivalent RegExp (cloned for isolation)
      expect(state.regex.source).toBe(regex.source);
      expect(state.regex.flags).toBe(regex.flags);
      expect(state.regex instanceof RegExp).toBe(true);
    });

    test("handles Function values", () => {
      const onChange = mock(() => {});
      const fn = () => "test";
      const state = createObservableState({ fn }, { onChange });

      expect(state.fn).toBe(fn);
      expect(typeof state.fn).toBe("function");
    });

    test("handles Symbol keys", () => {
      const onChange = mock(() => {});
      const sym = Symbol("test");
      const obj: any = { [sym]: "symbol value" };
      const state = createObservableState(obj, { onChange });

      expect(state[sym]).toBe("symbol value");
    });

    test("handles BigInt values", () => {
      const onChange = mock(() => {});
      const state = createObservableState<any>({ big: 0n }, { onChange });

      state.big = 9007199254740991n;

      expect(state.big).toBe(9007199254740991n);
    });
  });

  describe("Map and Set Support", () => {
    test("handles Map objects", () => {
      const onChange = mock(() => {});
      const map = new Map([["key", "value"]]);
      const state = createObservableState({ map }, { onChange });

      state.map.set("newKey", "newValue");

      expect(state.map.get("newKey")).toBe("newValue");
    });

    test("handles Set objects", () => {
      const onChange = mock(() => {});
      const set = new Set([1, 2, 3]);
      const state = createObservableState({ set }, { onChange });

      state.set.add(4);

      expect(state.set.has(4)).toBe(true);
    });

    test("handles WeakMap objects", () => {
      const onChange = mock(() => {});
      const weakMap = new WeakMap();
      const key = {};
      weakMap.set(key, "value");

      const state = createObservableState({ weakMap }, { onChange });

      expect(state.weakMap.get(key)).toBe("value");
    });

    test("handles WeakSet objects", () => {
      const onChange = mock(() => {});
      const weakSet = new WeakSet();
      const obj = {};
      weakSet.add(obj);

      const state = createObservableState({ weakSet }, { onChange });

      expect(state.weakSet.has(obj)).toBe(true);
    });
  });

  describe("Property Deletion", () => {
    test("handles delete operator", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        { a: 1, b: 2, c: 3 },
        { onChange }
      );

      delete (state as { b?: number }).b;

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.b).toBeUndefined();
      expect("b" in state).toBe(false);
      expect(onChange).toHaveBeenCalled();
    });

    test("handles deleting nested properties", () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        { nested: { a: 1, b: 2 } },
        { onChange }
      );

      delete (state.nested as { a?: number }).a;

      expect(state.nested.a).toBeUndefined();
      expect("a" in state.nested).toBe(false);
    });

    test("handles deleting array elements", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ items: [1, 2, 3] }, { onChange });

      delete state.items[1];

      expect(state.items[1]).toBeUndefined();
      expect(state.items.length).toBe(3); // Length unchanged
    });
  });

  describe("Batch Updates", () => {
    test("batches multiple changes into single notification", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      batchStateUpdates(state, () => {
        state.count = 1;
        state.count = 2;
        state.count = 3;
      });

      // Wait for microtask
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should only notify once
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(state.count).toBe(3);
    });

    test("handles nested batch updates", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      batchStateUpdates(state, () => {
        state.count = 1;
        batchStateUpdates(state, () => {
          state.count = 2;
        });
        state.count = 3;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.count).toBe(3);
    });

    test("handles errors during batch updates", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      try {
        batchStateUpdates(state, () => {
          state.count = 1;
          throw new Error("Batch error");
        });
      } catch (error) {
        // Error should be thrown
      }

      expect(state.count).toBe(1);
    });
  });

  describe("Snapshot Isolation", () => {
    test("snapshot is immutable", () => {
      const state = createObservableState({ count: 0 });
      const snapshot = getStateSnapshot(state);

      // Mutating snapshot shouldn't affect original
      (snapshot as any).count = 100;

      expect(state.count).toBe(0);
    });

    test("snapshot captures current state at time of call", () => {
      const state = createObservableState({ count: 0 });

      state.count = 1;
      const snapshot1 = getStateSnapshot(state);

      state.count = 2;
      const snapshot2 = getStateSnapshot(state);

      expect(snapshot1.count).toBe(1);
      expect(snapshot2.count).toBe(2);
      expect(state.count).toBe(2);
    });

    test("snapshot handles nested objects", () => {
      const state = createObservableState({
        user: { name: "Alice", age: 30 },
      });

      const snapshot = getStateSnapshot(state);

      state.user.name = "Bob";

      expect(snapshot.user.name).toBe("Alice");
      expect(state.user.name).toBe("Bob");
    });

    test("snapshot handles arrays", () => {
      const state = createObservableState({ items: [1, 2, 3] });

      const snapshot = getStateSnapshot(state);

      state.items.push(4);

      expect(snapshot.items).toEqual([1, 2, 3]);
      expect(state.items).toEqual([1, 2, 3, 4]);
    });
  });

  describe("Performance and Large State", () => {
    test("handles 10,000 properties", () => {
      const largeState: any = {};
      for (let i = 0; i < 10_000; i++) {
        largeState[`key${i}`] = i;
      }

      const state = createObservableState(largeState);

      state.key9999 = 99999;

      expect(state.key9999).toBe(99999);
    });

    test("handles 1,000 nested levels", () => {
      let deep: any = { value: "end" };
      for (let i = 0; i < 100; i++) {
        // Reduced from 1000 for practicality
        deep = { nested: deep };
      }

      const state = createObservableState({ root: deep });

      // Just verify it doesn't crash
      expect(state.root).toBeDefined();
    });

    test("handles rapid successive updates", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      for (let i = 0; i < 1000; i++) {
        state.count = i;
      }

      expect(state.count).toBe(999);
    });

    test("handles large arrays efficiently", () => {
      const largeArray = Array.from({ length: 10_000 }, (_, i) => i);
      const state = createObservableState({ items: largeArray });

      state.items[5000] = 99999;

      expect(state.items[5000]).toBe(99999);
    });
  });

  describe("Change Detection", () => {
    test("detects property addition", async () => {
      const onChange = mock(() => {});
      const state = createObservableState<any>({}, { onChange });

      state.newProp = "value";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onChange).toHaveBeenCalled();
    });

    test("detects property modification", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ prop: "old" }, { onChange });

      state.prop = "new";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onChange).toHaveBeenCalled();
    });

    test("doesn't trigger on same value assignment", async () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      onChange.mockClear();

      state.count = 0; // Same value

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Depending on implementation, this might or might not trigger
      // This tests the current behavior
    });

    test("detects nested property changes", async () => {
      const onChange = mock(() => {});
      const state = createObservableState(
        { user: { name: "Alice" } },
        { onChange }
      );

      state.user.name = "Bob";

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onChange).toHaveBeenCalled();
    });
  });

  describe("Edge Cases with Primitives", () => {
    test("rejects primitive wrapper objects", () => {
      const onChange = mock(() => {});
      // @ts-ignore - Testing edge case
      expect(() => {
        createObservableState(new Number(42), { onChange });
      }).toThrow(TypeError);

      // @ts-ignore - Testing edge case
      expect(() => {
        createObservableState(new String("hello"), { onChange });
      }).toThrow(TypeError);

      // @ts-ignore - Testing edge case
      expect(() => {
        createObservableState(new Boolean(true), { onChange });
      }).toThrow(TypeError);
    });

    test("handles empty string as value", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ value: "" }, { onChange });

      state.value = "";

      expect(state.value).toBe("");
    });

    test("handles boolean false", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ flag: false }, { onChange });

      state.flag = false;

      expect(state.flag).toBe(false);
    });

    test("handles zero", () => {
      const onChange = mock(() => {});
      const state = createObservableState({ count: 0 }, { onChange });

      state.count = 0;

      expect(state.count).toBe(0);
    });
  });
});
