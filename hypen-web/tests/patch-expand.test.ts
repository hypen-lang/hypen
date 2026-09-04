/**
 * TemplateExpander unit tests — TS mirror of the Rust canonical tests in
 * `hypen-engine-rs/src/portable/patch_expand.rs`. Output ordering and
 * prop merging must match the Rust expander exactly: this is the wire
 * contract that lets every boundary lower `registerTemplate`/`instantiate`
 * back into the plain `create`+`insert` run the pre-template wire carried.
 */

import { describe, expect, test } from "bun:test";
import { TemplateExpander } from "../packages/core/src/patch-expand";
import type { Patch, Semantics } from "../packages/core/src/types";

/** Row(gap: 8) { Text(fontSize: 14) Text() } — index 0 = Row, 1 = first
 *  Text, 2 = second Text (DFS preorder). */
function skeletonRow(): any {
  return {
    elementType: "Row",
    props: { gap: 8 },
    children: [
      { elementType: "Text", props: { fontSize: 14 }, children: [] },
      { elementType: "Text", props: {}, children: [] },
    ],
  };
}

function register(id: string, root: any): Patch {
  return { type: "registerTemplate", templateId: id, root };
}

function instantiate(
  id: string,
  parent: string,
  before: string | undefined,
  nodes: string[],
  subs: Array<[number, string, any]> = [],
  semantics: Array<[number, Semantics]> = [],
): Patch {
  const patch: Patch = {
    type: "instantiate",
    templateId: id,
    parentId: parent,
    nodes,
    subs,
    nodeSemantics: semantics,
  };
  if (before !== undefined) patch.beforeId = before;
  return patch;
}

describe("TemplateExpander", () => {
  // The full contract on one instance: interleaved C/I preorder, merged
  // props, root anchored at the instantiate's parent/before, children
  // appended under their template parent, semantics on the right node.
  test("expands to interleaved preorder run", () => {
    const expander = new TemplateExpander();
    const sem: Semantics = { name: "first" };
    const out = expander.expand([
      register("t1", skeletonRow()),
      instantiate(
        "t1",
        "7",
        "42",
        ["10", "11", "12"],
        [[1, "0", "Hello"]],
        [[1, sem]],
      ),
    ]);

    expect(out.length).toBe(6); // 3 elements -> 3 creates + 3 inserts

    expect(out[0]).toEqual({
      type: "create",
      id: "10",
      elementType: "Row",
      props: { gap: 8 },
    });
    expect(out[1]).toEqual({
      type: "insert",
      parentId: "7",
      id: "10",
      beforeId: "42",
    });
    expect(out[2]).toEqual({
      type: "create",
      id: "11",
      elementType: "Text",
      props: { fontSize: 14, "0": "Hello" }, // sub must merge in
      semantics: sem,
    });
    // Child inserts under the root's id; non-root inserts append.
    expect(out[3]).toEqual({ type: "insert", parentId: "10", id: "11" });
    expect(out[4]).toEqual({
      type: "create",
      id: "12",
      elementType: "Text",
      props: {},
    });
    expect(out[5]).toEqual({ type: "insert", parentId: "10", id: "12" });
  });

  // Registered skeletons persist across batches (session-lifetime state).
  test("registration survives across batches", () => {
    const expander = new TemplateExpander();
    const first = expander.expand([register("t1", skeletonRow())]);
    expect(first).toEqual([]); // registerTemplate is consumed

    const out = expander.expand([
      instantiate("t1", "root", undefined, ["1", "2", "3"]),
    ]);
    expect(out.length).toBe(6);
  });

  // An instantiate whose template was never registered passes through
  // unchanged (and warns) — never throws, never drops.
  test("unknown template passes through", () => {
    const expander = new TemplateExpander();
    const patch = instantiate("nope", "root", undefined, ["1"]);
    const out = expander.expand([patch]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(patch);
  });

  // A node-count mismatch against the skeleton passes through unchanged.
  test("node count mismatch passes through", () => {
    const expander = new TemplateExpander();
    const out = expander.expand([
      register("t1", skeletonRow()),
      instantiate("t1", "root", undefined, ["1", "2"]),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("instantiate");
  });

  // A malformed skeleton passes its registerTemplate through so a
  // downstream template-capable consumer still receives the pair.
  test("malformed skeleton passes pair through", () => {
    const expander = new TemplateExpander();
    const out = expander.expand([
      register("bad", { props: {} }),
      instantiate("bad", "root", undefined, ["1"]),
    ]);
    expect(out.length).toBe(2);
    expect(out[0]!.type).toBe("registerTemplate");
    expect(out[1]!.type).toBe("instantiate");
  });

  // Non-template patches pass through untouched with order preserved,
  // interleaved with expansions.
  test("other patches untouched in order", () => {
    const expander = new TemplateExpander();
    const setProp: Patch = { type: "setProp", id: "5", name: "color", value: "red" };
    const remove: Patch = { type: "remove", id: "9" };
    const out = expander.expand([
      setProp,
      register("t1", skeletonRow()),
      instantiate("t1", "root", undefined, ["1", "2", "3"]),
      remove,
    ]);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(setProp);
    expect(out[1]!.type).toBe("create");
    expect(out[7]).toBe(remove);
  });

  // A batch with no template patches is returned as-is (fast path).
  test("plain batch is identity", () => {
    const expander = new TemplateExpander();
    const patches: Patch[] = [{ type: "detach", id: "3" }];
    const out = expander.expand(patches);
    expect(out).toBe(patches);
  });

  // On a (theoretical) key collision the sub's per-instance value wins
  // over the skeleton's static value.
  test("subs win on key collision", () => {
    const expander = new TemplateExpander();
    const out = expander.expand([
      register("t1", {
        elementType: "Text",
        props: { "0": "static" },
        children: [],
      }),
      instantiate("t1", "root", undefined, ["1"], [[0, "0", "dynamic"]]),
    ]);
    expect(out[0]).toEqual({
      type: "create",
      id: "1",
      elementType: "Text",
      props: { "0": "dynamic" },
    });
  });

  // A leading batchAnimation stamp keeps index 0 through expansion — the
  // renderers' first-patch contract must survive registerTemplate being
  // consumed.
  test("leading batchAnimation stamp keeps index 0", () => {
    const expander = new TemplateExpander();
    const stamp: Patch = { type: "batchAnimation", spec: { curve: "spring" } };
    const out = expander.expand([
      stamp,
      register("t1", skeletonRow()),
      instantiate("t1", "root", undefined, ["1", "2", "3"]),
    ]);
    expect(out[0]).toBe(stamp);
    expect(out.length).toBe(7);
  });
});
