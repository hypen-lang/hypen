import { describe, expect, mock, test } from "bun:test";
import { BaseRenderer, ConsoleRenderer } from "../packages/core/src/renderer";
import type { Patch } from "../packages/core/src/types";

describe("BaseRenderer", () => {
  class TestRenderer extends BaseRenderer {
    public events: Array<{ type: string; args: unknown[] }> = [];

    applyPatches(patches: Patch[]): void {
      for (const patch of patches) {
        this.applyPatch(patch);
      }
    }

    protected onCreate(id: string, elementType: string, props: Record<string, unknown>): void {
      this.events.push({ type: "create", args: [id, elementType, props] });
      this.nodes.set(id, { type: elementType, props: { ...props } });
    }

    protected onSetProp(id: string, name: string, value: unknown): void {
      const node = this.nodes.get(id)!;
      node.props[name] = value;
      this.events.push({ type: "setProp", args: [id, name, value] });
    }

    protected onSetText(id: string, text: string): void {
      const node = this.nodes.get(id)!;
      node.text = text;
      this.events.push({ type: "setText", args: [id, text] });
    }

    protected onInsert(parentId: string, id: string, beforeId?: string): void {
      this.events.push({ type: "insert", args: [parentId, id, beforeId] });
    }

    protected onMove(parentId: string, id: string, beforeId?: string): void {
      this.events.push({ type: "move", args: [parentId, id, beforeId] });
    }

    protected onRemove(id: string): void {
      this.nodes.delete(id);
      this.events.push({ type: "remove", args: [id] });
    }

    protected onAttachEvent(id: string, eventName: string): void {
      this.events.push({ type: "attachEvent", args: [id, eventName] });
    }

    protected onDetachEvent(id: string, eventName: string): void {
      this.events.push({ type: "detachEvent", args: [id, eventName] });
    }
  }

  test("dispatches patches to abstract handlers", () => {
    const renderer = new TestRenderer();
    renderer.applyPatches([
      { type: "create", id: "root", elementType: "Column", props: { role: "main" } },
      { type: "setProp", id: "root", name: "role", value: "application" },
      { type: "setText", id: "root", text: "Hello" },
      { type: "insert", parentId: "container", id: "root" },
      { type: "move", parentId: "container", id: "root", beforeId: "child" },
      { type: "attachEvent", id: "root", eventName: "click" },
      { type: "detachEvent", id: "root", eventName: "click" },
      { type: "remove", id: "root" },
    ]);

    expect(renderer.events.map((e) => e.type)).toEqual([
      "create",
      "setProp",
      "setText",
      "insert",
      "move",
      "attachEvent",
      "detachEvent",
      "remove",
    ]);
    expect(renderer.getNode("root")).toBeUndefined();
  });

  test("clear removes all nodes", () => {
    const renderer = new TestRenderer();
    renderer.applyPatches([
      { type: "create", id: "node", elementType: "Box", props: {} },
    ]);

    expect(renderer.getNode("node")).toBeDefined();
    renderer.clear();
    expect(renderer.getNode("node")).toBeUndefined();
  });
});

describe("ConsoleRenderer", () => {
  test("logs patches in a group", () => {
    const group = mock(() => {});
    const groupEnd = mock(() => {});
    const log = mock(() => {});
    const original = { group: console.group, groupEnd: console.groupEnd, log: console.log };
    console.group = group as any;
    console.groupEnd = groupEnd as any;
    console.log = log as any;

    try {
      const renderer = new ConsoleRenderer();
      renderer.applyPatches([{ type: "create", id: "node" } as Patch]);
    } finally {
      console.group = original.group;
      console.groupEnd = original.groupEnd;
      console.log = original.log;
    }

    expect(group).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(groupEnd).toHaveBeenCalled();
  });
});
