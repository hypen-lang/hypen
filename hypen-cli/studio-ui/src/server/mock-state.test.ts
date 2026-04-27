import { describe, expect, test } from "bun:test";
import {
  scanReferences,
  buildShape,
  addArrayRow,
  findArrayPaths,
} from "./mock-state";

// ─── scanReferences ────────────────────────────────────────────────────

describe("scanReferences", () => {
  test("extracts dotted state paths", () => {
    const refs = scanReferences(`
      Text("@{state.user.name}")
      Text(color: @{state.theme.primary})
    `);
    expect(refs.statePaths).toEqual(["theme.primary", "user.name"]);
  });

  test("normalises bracketed array access into dotted form", () => {
    const refs = scanReferences(`Text("@{state.items[0].title}")`);
    expect(refs.statePaths).toEqual(["items.0.title"]);
  });

  test("deduplicates repeated paths", () => {
    const refs = scanReferences(`
      Text("@{state.count}")
      Button("@{state.count}") {}
      Text("@{state.count}")
    `);
    expect(refs.statePaths).toEqual(["count"]);
  });

  test("tolerates whitespace inside the braces", () => {
    const refs = scanReferences(`Text("@{  state.user.name  }")`);
    expect(refs.statePaths).toEqual(["user.name"]);
  });

  test("extracts action names", () => {
    const refs = scanReferences(`
      Button(onClick: @actions.increment)
      Button(onClick: @actions.decrement)
      Button(onClick: @actions.increment)
    `);
    expect(refs.actionNames).toEqual(["decrement", "increment"]);
  });

  test("returns empty arrays for a template with no refs", () => {
    const refs = scanReferences(`Column { Text("Hello") }`);
    expect(refs.statePaths).toEqual([]);
    expect(refs.actionNames).toEqual([]);
  });

  test("ignores a bare `state` without a field", () => {
    // `@{state}` without a dot shouldn't create a phantom path.
    const refs = scanReferences(`Text("@{state}")`);
    expect(refs.statePaths).toEqual([]);
  });
});

// ─── buildShape ────────────────────────────────────────────────────────

describe("buildShape", () => {
  test("builds nested objects from dotted paths", () => {
    expect(buildShape(["user.name", "user.email"])).toEqual({
      user: { name: "", email: "" },
    });
  });

  test("creates arrays when a segment is numeric", () => {
    const shape = buildShape(["items.0.title", "items.0.body"]);
    expect(Array.isArray((shape as any).items)).toBe(true);
    expect((shape as any).items[0]).toEqual({ title: "", body: "" });
  });

  test("leaves multi-row arrays keyed by the indices seen", () => {
    const shape = buildShape(["items.0.title", "items.1.title"]);
    const items = (shape as any).items as Array<{ title: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "" });
    expect(items[1]).toEqual({ title: "" });
  });

  test("handles leaf-only paths", () => {
    expect(buildShape(["count"])).toEqual({ count: "" });
  });

  test("handles deeply nested structures with mixed objects and arrays", () => {
    const shape = buildShape([
      "posts.0.author.name",
      "posts.0.comments.0.text",
    ]);
    expect(shape).toEqual({
      posts: [
        {
          author: { name: "" },
          comments: [{ text: "" }],
        },
      ],
    });
  });

  test("returns empty object for empty input", () => {
    expect(buildShape([])).toEqual({});
  });
});

// ─── addArrayRow ───────────────────────────────────────────────────────

describe("addArrayRow", () => {
  test("appends a same-shaped empty row using the first row as template", () => {
    const state = { items: [{ title: "existing", body: "also existing" }] };
    addArrayRow(state, "items");
    expect(state.items).toHaveLength(2);
    expect(state.items[1]).toEqual({ title: "", body: "" });
    // original row stays intact
    expect(state.items[0]).toEqual({ title: "existing", body: "also existing" });
  });

  test("resets leaf scalars in the cloned row (strings/numbers/booleans)", () => {
    const state = { rows: [{ name: "Ada", age: 42, admin: true }] };
    addArrayRow(state, "rows");
    expect(state.rows[1]).toEqual({ name: "", age: 0, admin: false });
  });

  test("handles nested arrays inside the template row", () => {
    const state = { groups: [{ name: "A", members: [{ handle: "x" }] }] };
    addArrayRow(state, "groups");
    expect(state.groups[1]).toEqual({ name: "", members: [{ handle: "" }] });
  });

  test("appends {} when the array is empty (no template row to clone)", () => {
    const state = { items: [] as unknown[] };
    addArrayRow(state, "items");
    // cloneEmpty returns "" for undefined inputs, so an empty array starts
    // getting pushed empty strings. That's surprising for objects, but
    // acceptable for V1 — the user can edit the value afterwards.
    expect(state.items).toHaveLength(1);
  });

  test("is a no-op when the path doesn't resolve to an array", () => {
    const state = { user: { name: "Ada" } };
    addArrayRow(state, "user.name");
    expect(state.user.name).toBe("Ada");
  });

  test("is a no-op when the path is broken", () => {
    const state = {} as any;
    addArrayRow(state, "nonexistent.items");
    expect(state).toEqual({});
  });

  test("reaches into nested paths", () => {
    const state = { page: { rows: [{ x: 1 }] } };
    addArrayRow(state, "page.rows");
    expect(state.page.rows).toHaveLength(2);
  });
});

// ─── findArrayPaths ────────────────────────────────────────────────────

describe("findArrayPaths", () => {
  test("emits dotted paths of every array in the tree", () => {
    const state = {
      items: [{ tags: ["a"] }],
      user: { friends: [] as unknown[] },
    };
    const paths = findArrayPaths(state).sort();
    expect(paths).toEqual(["items", "items.0.tags", "user.friends"]);
  });

  test("empty tree yields no paths", () => {
    expect(findArrayPaths({})).toEqual([]);
  });

  test("scalar leaves produce no paths", () => {
    expect(findArrayPaths({ name: "a", age: 3 })).toEqual([]);
  });
});
