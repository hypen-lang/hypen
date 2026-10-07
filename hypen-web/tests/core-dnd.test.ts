/**
 * Shared drag-and-drop module (`@hypen-space/core/dnd`) — the
 * renderer-agnostic half of the `__dnd.*` prop channel contract
 * (hypen-web/docs/dnd.md).
 *
 * Prop keys, action names, parser defaults, the band rule, grid snapping,
 * the keyboard drag state machine, and the `applyPathMove` mirror of
 * `portable::path_move` are pinned here. The Rust lowering in
 * `hypen-engine-rs/src/ir/dnd.rs` must emit the shapes parsed here, and the
 * `path_move` conformance fixture (when present) is run through the TS
 * mirror so the two splices cannot drift.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  DND_PROP_PREFIX,
  DND_SOURCE_PROP,
  DND_SOURCE_PAYLOAD_PROP,
  DND_SOURCE_ENABLED_PROP,
  DND_KEY_PROP,
  DND_ZONE_PROP,
  DND_ZONE_ID_PROP,
  DND_ZONE_ENABLED_PROP,
  DND_SORT_PROP,
  DND_PIN_PROP,
  DND_PIN_GROUP_PROP,
  DND_PROPS,
  DND_REORDER_ACTION,
  DND_PIN_ACTION,
  DND_RESERVED_STATE_KEY,
  DND_EVENT_NAMES,
  DND_DRAG_OVER_DWELL_KEY,
  DND_DEFAULT_DWELL_MS,
  DND_LABEL_LIFTED,
  DND_LABEL_OVER,
  DND_DEFAULT_BAND,
  parseDndSource,
  parseDndZone,
  parseDndSort,
  parseDndPin,
  parseDndEnabled,
  parseDndString,
  resolveBand,
  snapToGrid,
  reservedPinPath,
  userPinPath,
  applyPathMove,
  KeyboardDragMachine,
} from "../packages/core/src/dnd";
import * as coreIndex from "../packages/core/src/index";
import * as browserIndex from "../packages/core/src/index.browser";

// ============================================================================
// CONSTANTS
// ============================================================================

describe("dnd constants", () => {
  test("every reserved prop shares the __dnd. prefix and matches §2", () => {
    expect(DND_PROP_PREFIX).toBe("__dnd.");
    expect(DND_SOURCE_PROP).toBe("__dnd.source");
    expect(DND_SOURCE_PAYLOAD_PROP).toBe("__dnd.sourcePayload");
    expect(DND_SOURCE_ENABLED_PROP).toBe("__dnd.sourceEnabled");
    expect(DND_KEY_PROP).toBe("__dnd.key");
    expect(DND_ZONE_PROP).toBe("__dnd.zone");
    expect(DND_ZONE_ID_PROP).toBe("__dnd.zoneId");
    expect(DND_ZONE_ENABLED_PROP).toBe("__dnd.zoneEnabled");
    expect(DND_SORT_PROP).toBe("__dnd.sort");
    expect(DND_PIN_PROP).toBe("__dnd.pin");
    expect(DND_PIN_GROUP_PROP).toBe("__dnd.pinGroup");
    expect(DND_PROPS).toHaveLength(15);
    for (const prop of DND_PROPS) expect(prop.startsWith(DND_PROP_PREFIX)).toBe(true);
    expect(new Set(DND_PROPS).size).toBe(DND_PROPS.length);
  });

  test("reserved actions, events, dwell, labels (§2.1, §2.2, §4.1)", () => {
    expect(DND_REORDER_ACTION).toBe("__hypen_reorder");
    expect(DND_PIN_ACTION).toBe("__hypen_pin");
    expect(DND_RESERVED_STATE_KEY).toBe("__dnd");
    expect([...DND_EVENT_NAMES]).toEqual([
      "onDragStart",
      "onDragOver",
      "onDrop",
      "onSort",
      "onPin",
      "onDragEnd",
    ]);
    expect(DND_DRAG_OVER_DWELL_KEY).toBe("dwell");
    expect(DND_DEFAULT_DWELL_MS).toBe(500);
    expect(DND_LABEL_LIFTED).toBe("lifted");
    expect(DND_LABEL_OVER).toBe("over");
    expect(DND_DEFAULT_BAND).toBe(0.5);
  });

  test("is re-exported from both package barrels like animation.ts", () => {
    for (const barrel of [coreIndex, browserIndex] as Record<string, unknown>[]) {
      expect(barrel.DND_PROP_PREFIX).toBe(DND_PROP_PREFIX);
      expect(barrel.DND_REORDER_ACTION).toBe(DND_REORDER_ACTION);
      expect(barrel.DND_PIN_ACTION).toBe(DND_PIN_ACTION);
      expect(typeof barrel.parseDndSource).toBe("function");
      expect(typeof barrel.applyPathMove).toBe("function");
      expect(typeof barrel.resolveBand).toBe("function");
      expect(typeof barrel.KeyboardDragMachine).toBe("function");
    }
  });

  test("package.json exposes the ./dnd subpath", async () => {
    const pkg = await Bun.file(
      new URL("../packages/core/package.json", import.meta.url).pathname
    ).json();
    expect(pkg.exports["./dnd"]).toEqual({
      types: "./dist/dnd.d.ts",
      bun: "./src/dnd.ts",
      import: "./dist/dnd.js",
      default: "./dist/dnd.js",
    });
  });

  // build.ts enumerates entrypoints explicitly and builds with `splitting`,
  // so a subpath whose src file is not an entrypoint has NO dist/<name>.js
  // (only hashed chunks) — it resolves under Bun's `bun` condition and is
  // silently broken for every other consumer. Pin: every `import` target in
  // package.json exports is produced by a listed entrypoint.
  test("every package.json subpath `import` target is a build.ts entrypoint", async () => {
    const pkg = await Bun.file(
      new URL("../packages/core/package.json", import.meta.url).pathname
    ).json();
    const buildSrc = await Bun.file(
      new URL("../packages/core/build.ts", import.meta.url).pathname
    ).text();
    const entrypoints = new Set(
      [...buildSrc.matchAll(/"(\.\/src\/[^"]+\.ts)"/g)].map((m) => m[1]!)
    );
    expect(entrypoints.has("./src/dnd.ts")).toBe(true);
    const missing: string[] = [];
    for (const [subpath, target] of Object.entries<any>(pkg.exports)) {
      const importTarget: string | undefined =
        typeof target === "string" ? target : target?.import ?? target?.default;
      if (!importTarget || !importTarget.startsWith("./dist/")) continue;
      // ./dist/<x>.js ← ./src/<x>.ts, except where the `bun` condition names the source.
      const src =
        typeof target === "object" && typeof target.bun === "string"
          ? target.bun
          : importTarget.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
      if (!entrypoints.has(src)) missing.push(`${subpath} → ${importTarget} (${src})`);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// PARSERS
// ============================================================================

describe("parseDndSource", () => {
  test("full spec passes through", () => {
    expect(
      parseDndSource({ group: "cards", handle: true, activation: "press" })
    ).toEqual({ group: "cards", handle: true, activation: "press" });
  });

  test("missing fields take the §2 defaults", () => {
    expect(parseDndSource({})).toEqual({ group: null, handle: false, activation: "auto" });
  });

  test("malformed fields degrade to defaults, not null", () => {
    expect(
      parseDndSource({ group: 42, handle: "yes", activation: "teleport" })
    ).toEqual({ group: null, handle: false, activation: "auto" });
    expect(parseDndSource({ group: "" })!.group).toBeNull();
  });

  test("every activation token is accepted", () => {
    for (const activation of ["auto", "slop", "press", "immediate"]) {
      expect(parseDndSource({ activation })!.activation).toBe(activation as never);
    }
  });

  test("non-object channel → null; stringified JSON is tolerated", () => {
    expect(parseDndSource(null)).toBeNull();
    expect(parseDndSource(undefined)).toBeNull();
    expect(parseDndSource(7)).toBeNull();
    expect(parseDndSource([])).toBeNull();
    expect(parseDndSource("not json")).toBeNull();
    expect(parseDndSource('{"group":"g"}')).toEqual({
      group: "g",
      handle: false,
      activation: "auto",
    });
  });
});

describe("parseDndZone", () => {
  test("defaults: group null, band 0.5", () => {
    expect(parseDndZone({})).toEqual({ group: null, band: 0.5, files: false, accept: null });
  });

  test("band clamps to [0,1]; non-number → default", () => {
    expect(parseDndZone({ band: 0.25 })!.band).toBe(0.25);
    expect(parseDndZone({ band: 3 })!.band).toBe(1);
    expect(parseDndZone({ band: -1 })!.band).toBe(0);
    expect(parseDndZone({ band: "half" })!.band).toBe(0.5);
    expect(parseDndZone({ band: Number.NaN })!.band).toBe(0.5);
  });

  test("malformed → null", () => {
    expect(parseDndZone(null)).toBeNull();
    expect(parseDndZone("x")).toBeNull();
  });
});

describe("parseDndSort", () => {
  test("defaults: group null, axis y", () => {
    expect(parseDndSort({})).toEqual({ group: null, axis: "y" });
    expect(parseDndSort({ group: "list", axis: "x" })).toEqual({ group: "list", axis: "x" });
    expect(parseDndSort({ axis: "z" })!.axis).toBe("y");
  });

  test("malformed → null", () => {
    expect(parseDndSort(undefined)).toBeNull();
    expect(parseDndSort([1])).toBeNull();
  });
});

describe("parseDndPin", () => {
  test("defaults per §2", () => {
    expect(parseDndPin({})).toEqual({
      group: null,
      xKey: "x",
      yKey: "y",
      grid: null,
      bounds: "clamp",
      units: "px",
    });
  });

  test("full spec passes through", () => {
    expect(
      parseDndPin({
        group: "board",
        xKey: "left",
        yKey: "top",
        grid: 8,
        bounds: "free",
        units: "fraction",
      })
    ).toEqual({
      group: "board",
      xKey: "left",
      yKey: "top",
      grid: 8,
      bounds: "free",
      units: "fraction",
    });
  });

  test("non-positive / non-finite grid → null; bad enums → defaults", () => {
    expect(parseDndPin({ grid: 0 })!.grid).toBeNull();
    expect(parseDndPin({ grid: -4 })!.grid).toBeNull();
    expect(parseDndPin({ grid: Number.POSITIVE_INFINITY })!.grid).toBeNull();
    expect(parseDndPin({ grid: "8" })!.grid).toBeNull();
    expect(parseDndPin({ bounds: "wrap", units: "em", xKey: "", yKey: 3 })).toEqual({
      group: null,
      xKey: "x",
      yKey: "y",
      grid: null,
      bounds: "clamp",
      units: "px",
    });
  });

  test("malformed → null", () => {
    expect(parseDndPin(null)).toBeNull();
    expect(parseDndPin(true)).toBeNull();
  });
});

describe("parseDndEnabled / parseDndString", () => {
  test("enabled: absent ⇒ true, only explicit false disables", () => {
    expect(parseDndEnabled(undefined)).toBe(true);
    expect(parseDndEnabled(null)).toBe(true);
    expect(parseDndEnabled(true)).toBe(true);
    expect(parseDndEnabled(false)).toBe(false);
    expect(parseDndEnabled("false")).toBe(false);
    expect(parseDndEnabled(0)).toBe(true);
  });

  test("string: nonempty string or finite number, else null", () => {
    expect(parseDndString("n1")).toBe("n1");
    expect(parseDndString(42)).toBe("42");
    expect(parseDndString("")).toBeNull();
    expect(parseDndString(null)).toBeNull();
    expect(parseDndString({})).toBeNull();
  });
});

// ============================================================================
// GEOMETRY
// ============================================================================

describe("resolveBand", () => {
  // Item spans [100, 200); band 0.5 → before [100,125), into [125,175), after [175,200)
  test("default band splits 25/50/25 with half-open boundaries", () => {
    expect(resolveBand(100, 100, 100, 0.5)).toBe("before");
    expect(resolveBand(124.999, 100, 100, 0.5)).toBe("before");
    expect(resolveBand(125, 100, 100, 0.5)).toBe("into");
    expect(resolveBand(150, 100, 100, 0.5)).toBe("into");
    expect(resolveBand(174.999, 100, 100, 0.5)).toBe("into");
    expect(resolveBand(175, 100, 100, 0.5)).toBe("after");
    expect(resolveBand(199, 100, 100, 0.5)).toBe("after");
  });

  test("pointer outside the item resolves by side", () => {
    expect(resolveBand(0, 100, 100, 0.5)).toBe("before");
    expect(resolveBand(200, 100, 100, 0.5)).toBe("after");
    expect(resolveBand(1000, 100, 100, 0.5)).toBe("after");
  });

  test("band 0 never yields into (midpoint split)", () => {
    expect(resolveBand(149.999, 100, 100, 0)).toBe("before");
    expect(resolveBand(150, 100, 100, 0)).toBe("after");
  });

  test("band 1 yields into anywhere inside the item", () => {
    expect(resolveBand(100, 100, 100, 1)).toBe("into");
    expect(resolveBand(199.999, 100, 100, 1)).toBe("into");
    expect(resolveBand(99.999, 100, 100, 1)).toBe("before");
    expect(resolveBand(200, 100, 100, 1)).toBe("after");
  });

  test("band outside [0,1] clamps; non-finite band → default", () => {
    expect(resolveBand(150, 100, 100, 5)).toBe("into");
    expect(resolveBand(100, 100, 100, 5)).toBe("into");
    expect(resolveBand(150, 100, 100, -1)).toBe("after");
    expect(resolveBand(130, 100, 100, Number.NaN)).toBe("into");
    expect(resolveBand(120, 100, 100, Number.NaN)).toBe("before");
  });

  test("zero / negative / non-finite length degrades to a point split at start", () => {
    expect(resolveBand(99, 100, 0, 0.5)).toBe("before");
    expect(resolveBand(100, 100, 0, 0.5)).toBe("after");
    expect(resolveBand(100, 100, -10, 0.5)).toBe("after");
    expect(resolveBand(100, 100, Number.NaN, 0.5)).toBe("after");
  });
});

describe("snapToGrid", () => {
  test("rounds to the nearest multiple", () => {
    expect(snapToGrid(13, 8)).toBe(16);
    expect(snapToGrid(11, 8)).toBe(8);
    expect(snapToGrid(12, 8)).toBe(16); // .5 rounds up
    expect(snapToGrid(-13, 8)).toBe(-16);
    expect(snapToGrid(0, 8)).toBe(0);
    expect(snapToGrid(7.5, 2.5)).toBe(7.5);
  });

  test("null / non-positive / non-finite grid leaves the value alone", () => {
    expect(snapToGrid(13, null)).toBe(13);
    expect(snapToGrid(13, 0)).toBe(13);
    expect(snapToGrid(13, -8)).toBe(13);
    expect(snapToGrid(13, Number.NaN)).toBe(13);
    expect(snapToGrid(13, Number.POSITIVE_INFINITY)).toBe(13);
  });

  test("non-finite value passes through", () => {
    expect(snapToGrid(Number.NaN, 8)).toBeNaN();
  });
});

describe("pin path helpers", () => {
  test("reserved and user-field base paths", () => {
    expect(reservedPinPath("board", "n1")).toBe("__dnd.board.n1");
    expect(userPinPath("notes", 3)).toBe("notes.3");
  });
});

// ============================================================================
// applyPathMove — TS mirror of portable::path_move (§5)
// ============================================================================

type MoveCase = {
  name: string;
  value: unknown;
  fromPath: string;
  from: number;
  toPath: string;
  to: number;
  expected: unknown;
  moved: boolean;
};

// Inline copy of the conformance cases. If the engine agent's fixture at
// engine-compatibility-tests/fixtures/dnd/path-move.json exists, it is ALSO
// run below; these inline cases stay as the floor.
const PATH_MOVE_CASES: MoveCase[] = [
  {
    name: "same-array forward",
    value: { items: ["a", "b", "c", "d"] },
    fromPath: "items", from: 0, toPath: "items", to: 2,
    expected: { items: ["b", "c", "a", "d"] },
    moved: true,
  },
  {
    name: "same-array backward",
    value: { items: ["a", "b", "c", "d"] },
    fromPath: "items", from: 3, toPath: "items", to: 0,
    expected: { items: ["d", "a", "b", "c"] },
    moved: true,
  },
  {
    name: "same-array from == to is a no-op returning true",
    value: { items: ["a", "b", "c"] },
    fromPath: "items", from: 1, toPath: "items", to: 1,
    expected: { items: ["a", "b", "c"] },
    moved: true,
  },
  {
    name: "same-array to beyond length clamps to end (after removal)",
    value: { items: ["a", "b", "c"] },
    fromPath: "items", from: 0, toPath: "items", to: 99,
    expected: { items: ["b", "c", "a"] },
    moved: true,
  },
  {
    name: "same-array to == length lands at the end",
    value: { items: ["a", "b", "c"] },
    fromPath: "items", from: 0, toPath: "items", to: 3,
    expected: { items: ["b", "c", "a"] },
    moved: true,
  },
  {
    name: "cross-array transfer at index",
    value: { todo: ["a", "b", "c"], done: ["x", "y"] },
    fromPath: "todo", from: 1, toPath: "done", to: 1,
    expected: { todo: ["a", "c"], done: ["x", "b", "y"] },
    moved: true,
  },
  {
    name: "cross-array to == dest length appends",
    value: { todo: ["a", "b"], done: ["x"] },
    fromPath: "todo", from: 0, toPath: "done", to: 1,
    expected: { todo: ["b"], done: ["x", "a"] },
    moved: true,
  },
  {
    name: "cross-array to beyond dest length clamps to append",
    value: { todo: ["a", "b"], done: ["x"] },
    fromPath: "todo", from: 0, toPath: "done", to: 50,
    expected: { todo: ["b"], done: ["x", "a"] },
    moved: true,
  },
  {
    name: "cross-array into empty destination",
    value: { todo: ["a"], done: [] },
    fromPath: "todo", from: 0, toPath: "done", to: 0,
    expected: { todo: [], done: ["a"] },
    moved: true,
  },
  {
    name: "nested paths",
    value: { board: { cols: [{ cards: ["a", "b"] }, { cards: ["c"] }] } },
    fromPath: "board.cols.0.cards", from: 1, toPath: "board.cols.1.cards", to: 0,
    expected: { board: { cols: [{ cards: ["a"] }, { cards: ["b", "c"] }] } },
    moved: true,
  },
  {
    name: "object elements move by reference",
    value: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    fromPath: "items", from: 2, toPath: "items", to: 0,
    expected: { items: [{ id: 3 }, { id: 1 }, { id: 2 }] },
    moved: true,
  },
  {
    name: "from out of range → false, untouched",
    value: { items: ["a", "b"] },
    fromPath: "items", from: 2, toPath: "items", to: 0,
    expected: { items: ["a", "b"] },
    moved: false,
  },
  {
    name: "from path not an array → false, untouched",
    value: { items: { a: 1 }, other: [] },
    fromPath: "items", from: 0, toPath: "other", to: 0,
    expected: { items: { a: 1 }, other: [] },
    moved: false,
  },
  {
    name: "to path not an array → false, untouched",
    value: { items: ["a"], other: "nope" },
    fromPath: "items", from: 0, toPath: "other", to: 0,
    expected: { items: ["a"], other: "nope" },
    moved: false,
  },
  {
    name: "missing path → false, untouched",
    value: { items: ["a"] },
    fromPath: "missing", from: 0, toPath: "items", to: 0,
    expected: { items: ["a"] },
    moved: false,
  },
  {
    name: "empty source array → false",
    value: { items: [] },
    fromPath: "items", from: 0, toPath: "items", to: 0,
    expected: { items: [] },
    moved: false,
  },
  {
    name: "negative to → false, untouched",
    value: { items: ["a", "b"] },
    fromPath: "items", from: 0, toPath: "items", to: -1,
    expected: { items: ["a", "b"] },
    moved: false,
  },
  {
    name: "non-integer index → false, untouched",
    value: { items: ["a", "b"] },
    fromPath: "items", from: 0.5, toPath: "items", to: 1,
    expected: { items: ["a", "b"] },
    moved: false,
  },
  // Tree DnD (fixture: into-later-sibling-subtree-reindexes) — the
  // destination lives inside the source array past `from`; the removal
  // shifts it down by one but the same element must receive the item.
  {
    name: "into later sibling's subtree (destination re-addressed after removal)",
    value: { entries: [{ id: "f", children: [] }, { id: "a", children: ["a1"] }, { id: "b", children: ["b1"] }] },
    fromPath: "entries", from: 0, toPath: "entries.2.children", to: 1,
    expected: { entries: [{ id: "a", children: ["a1"] }, { id: "b", children: ["b1", { id: "f", children: [] }] }] },
    moved: true,
  },
  {
    name: "into earlier sibling's subtree",
    value: { entries: [{ children: [] }, "x"] },
    fromPath: "entries", from: 1, toPath: "entries.0.children", to: 0,
    expected: { entries: [{ children: ["x"] }] },
    moved: true,
  },
  {
    name: "out of a nested subtree into the parent array",
    value: { entries: [{ children: ["a1"] }, "x"] },
    fromPath: "entries.0.children", from: 0, toPath: "entries", to: 0,
    expected: { entries: ["a1", { children: [] }, "x"] },
    moved: true,
  },
  // Fixture: into-own-subtree-untouched — Rust path.rs refuses a destination
  // inside the moved element; the TS mirror must not drop the item.
  {
    name: "into the moved element's own subtree → false, untouched",
    value: { items: [{ children: [] }, { children: ["z"] }] },
    fromPath: "items", from: 0, toPath: "items.0.children", to: 0,
    expected: { items: [{ children: [] }, { children: ["z"] }] },
    moved: false,
  },
  {
    name: "onto the moved element itself as destination → false, untouched",
    value: { items: [["inner"], "b"] },
    fromPath: "items", from: 0, toPath: "items.0", to: 0,
    expected: { items: [["inner"], "b"] },
    moved: false,
  },
  {
    name: "root array: into own subtree → false, untouched",
    value: [{ kids: [] }, "b"],
    fromPath: "", from: 0, toPath: "0.kids", to: 0,
    expected: [{ kids: [] }, "b"],
    moved: false,
  },
];

describe("applyPathMove (portable::path_move mirror, §5)", () => {
  for (const c of PATH_MOVE_CASES) {
    test(c.name, () => {
      const value = structuredClone(c.value);
      expect(applyPathMove(value, c.fromPath, c.from, c.toPath, c.to)).toBe(c.moved);
      expect(value).toEqual(c.expected);
    });
  }

  test("aliased paths resolving to the same array behave as same-array", () => {
    const shared = ["a", "b", "c"];
    const value = { x: shared, y: shared };
    expect(applyPathMove(value, "x", 0, "y", 2)).toBe(true);
    expect(shared).toEqual(["b", "c", "a"]);
  });

  test("aliased spelling of the moved element's own subtree is refused structurally", () => {
    const kids: unknown[] = [];
    const node = { kids };
    const value = { items: [node, "b"], alias: kids };
    // `alias` IS `items.0.kids`; no path-prefix relation, so only the
    // structural walk can catch it. Must not drop `node` from state.
    expect(applyPathMove(value, "items", 0, "alias", 0)).toBe(false);
    expect(value.items).toEqual([node, "b"]);
    expect(kids).toEqual([]);
  });

  test("root path '' resolves to root (not an array → false)", () => {
    const value = { items: ["a"] };
    expect(applyPathMove(value, "", 0, "items", 0)).toBe(false);
    expect(value).toEqual({ items: ["a"] });
  });

  test("root array via '' path", () => {
    const value = ["a", "b", "c"];
    expect(applyPathMove(value, "", 2, "", 0)).toBe(true);
    expect(value).toEqual(["c", "a", "b"]);
  });

  test("non-string paths → false", () => {
    const value = { items: ["a", "b"] };
    expect(applyPathMove(value, null as unknown as string, 0, "items", 1)).toBe(false);
    expect(value).toEqual({ items: ["a", "b"] });
  });

  // The engine-side conformance fixture (engine-compatibility-tests/
  // fixtures/dnd/README.md schema: `{ function, cases: [{ name, state, op:
  // { fromPath, from, toPath, to }, expected, moved }] }`) is run here too
  // so the TS splice cannot drift from Rust's `portable::path_move`.
  const fixtureDir = new URL(
    "../../engine-compatibility-tests/fixtures/dnd/",
    import.meta.url
  ).pathname;
  const fixturePath = fixtureDir + "path-move.json";

  type FixtureCase = {
    name: string;
    state: unknown;
    op: { fromPath: string; from: number; toPath: string; to: number };
    expected: unknown;
    moved: boolean;
  };

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  const runFixtureCase = (fx: FixtureCase): void => {
    expect(isPlainObject(fx.op)).toBe(true);
    expect(typeof fx.op.fromPath).toBe("string");
    expect(typeof fx.op.toPath).toBe("string");
    expect(typeof fx.moved).toBe("boolean");
    const value = structuredClone(fx.state);
    const moved = applyPathMove(value, fx.op.fromPath, fx.op.from, fx.op.toPath, fx.op.to);
    expect(moved).toBe(fx.moved);
    expect(value).toEqual(fx.expected);
  };

  test("engine-compatibility-tests/fixtures/dnd/path-move.json exists (§5 conformance)", () => {
    expect(existsSync(fixturePath)).toBe(true);
  });

  test.skipIf(!existsSync(fixtureDir))(
    "engine-compatibility-tests/fixtures/dnd/*.json path_move cases agree with the TS mirror",
    async () => {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);
      let ran = 0;
      const seen = new Set<string>();
      for (const file of files) {
        const fixture = await Bun.file(fixtureDir + file).json();
        const fn = typeof fixture.function === "string" ? fixture.function : undefined;
        const cases: FixtureCase[] = Array.isArray(fixture.cases) ? fixture.cases : [];
        for (const fx of cases) {
          const caseFn = typeof (fx as any).function === "string" ? (fx as any).function : fn;
          if (caseFn !== "path_move") continue;
          expect(seen.has(`${file}:${fx.name}`)).toBe(false);
          seen.add(`${file}:${fx.name}`);
          runFixtureCase(fx);
          ran++;
        }
      }
      // The fixture pins the tree-DnD refusal the inline floor also carries.
      expect(seen.has("path-move.json:into-own-subtree-untouched")).toBe(true);
      expect(ran).toBeGreaterThanOrEqual(17);
    }
  );
});

// ============================================================================
// KeyboardDragMachine (§6 item 8)
// ============================================================================

describe("KeyboardDragMachine", () => {
  test("starts idle; drop/cancel/move are null no-ops when idle", () => {
    const m = new KeyboardDragMachine();
    expect(m.state).toBe("idle");
    expect(m.lifted).toBe(false);
    expect(m.drop()).toBeNull();
    expect(m.cancel()).toBeNull();
    expect(m.move("next")).toBeNull();
    expect(m.moveZone("next")).toBeNull();
    expect(m.current()).toBeNull();
    expect(m.origin()).toBeNull();
    expect(m.describe()).toBeNull();
    expect(m.hasMoved()).toBe(false);
  });

  test("lift → arrows within a sortable → drop emits the §4.2 payload", () => {
    const m = new KeyboardDragMachine();
    expect(m.lift("t3", [{ id: "tasks", count: 5 }], 2)).toBe(true);
    expect(m.state).toBe("lifted");
    expect(m.origin()).toEqual({ zone: "tasks", index: 2 });
    expect(m.current()).toEqual({ zone: "tasks", index: 2 });
    expect(m.hasMoved()).toBe(false);
    expect(m.describe()).toBe("t3, position 3 of 5");

    expect(m.move("next")).toEqual({ zone: "tasks", index: 3 });
    expect(m.move("next")).toEqual({ zone: "tasks", index: 4 });
    // Clamped at count - 1 in the origin zone (the item occupies a slot).
    expect(m.move("next")).toEqual({ zone: "tasks", index: 4 });
    expect(m.hasMoved()).toBe(true);
    expect(m.describe()).toBe("t3, position 5 of 5");

    expect(m.drop()).toEqual({
      item: "t3",
      from: { zone: "tasks", index: 2 },
      to: { zone: "tasks", index: 4 },
    });
    expect(m.state).toBe("idle");
    expect(m.drop()).toBeNull();
  });

  test("prev clamps at 0", () => {
    const m = new KeyboardDragMachine();
    m.lift("a", [{ id: "list", count: 3 }], 1);
    expect(m.move("prev")).toEqual({ zone: "list", index: 0 });
    expect(m.move("prev")).toEqual({ zone: "list", index: 0 });
  });

  test("bare-string zone = sortable of unknown length (unbounded next, clamped at 0)", () => {
    const m = new KeyboardDragMachine();
    expect(m.lift("a", ["list"], 1)).toBe(true);
    expect(m.move("next")).toEqual({ zone: "list", index: 2 });
    expect(m.move("next")).toEqual({ zone: "list", index: 3 });
    expect(m.describe()).toBe("a, position 4");
    expect(m.move("prev")).toEqual({ zone: "list", index: 2 });
  });

  test("cancel returns the hover position for onDragEnd {dropped:false} and idles", () => {
    const m = new KeyboardDragMachine();
    m.lift("t1", [{ id: "tasks", count: 3 }], 0);
    m.move("next");
    expect(m.cancel()).toEqual({
      item: "t1",
      from: { zone: "tasks", index: 0 },
      to: { zone: "tasks", index: 1 },
    });
    expect(m.state).toBe("idle");
    expect(m.cancel()).toBeNull();
  });

  test("Tab cycles zones with wrap; foreign sortable appends, plain zone is 'into', origin restores", () => {
    const m = new KeyboardDragMachine();
    const zones = [
      { id: "todo", count: 3 },
      { id: "done", count: 2 },
      { id: "trash", count: null },
    ];
    expect(m.lift("t2", zones, 1)).toBe(true);

    // → done: append (index == count), arrows clamp to [0, count]
    expect(m.moveZone("next")).toEqual({ zone: "done", index: 2 });
    expect(m.describe()).toBe("t2, done, position 3 of 3");
    expect(m.move("next")).toEqual({ zone: "done", index: 2 });
    expect(m.move("prev")).toEqual({ zone: "done", index: 1 });
    expect(m.move("prev")).toEqual({ zone: "done", index: 0 });
    expect(m.move("prev")).toEqual({ zone: "done", index: 0 });

    // → trash: a plain drop zone targets "into" (null); arrows are no-ops
    expect(m.moveZone("next")).toEqual({ zone: "trash", index: null });
    expect(m.move("next")).toEqual({ zone: "trash", index: null });
    expect(m.describe()).toBe("t2, over trash");
    expect(m.hasMoved()).toBe(true);

    // → wraps to origin, restoring the lifted slot
    expect(m.moveZone("next")).toEqual({ zone: "todo", index: 1 });
    expect(m.hasMoved()).toBe(false);

    // Shift+Tab wraps backwards
    expect(m.moveZone("prev")).toEqual({ zone: "trash", index: null });
    expect(m.moveZone("prev")).toEqual({ zone: "done", index: 2 });

    expect(m.drop()).toEqual({
      item: "t2",
      from: { zone: "todo", index: 1 },
      to: { zone: "done", index: 2 },
    });
  });

  test("drop into a plain zone carries index null", () => {
    const m = new KeyboardDragMachine();
    m.lift("f1", [{ id: "files", count: 4 }, { id: "folder-a", count: null }], 0);
    m.moveZone("next");
    expect(m.drop()).toEqual({
      item: "f1",
      from: { zone: "files", index: 0 },
      to: { zone: "folder-a", index: null },
    });
  });

  test("origin can be any entry of zoneOrder", () => {
    const m = new KeyboardDragMachine();
    expect(m.lift("x", ["a", { id: "b", count: 2 }, "c"], 0, 1)).toBe(true);
    expect(m.origin()).toEqual({ zone: "b", index: 0 });
    expect(m.moveZone("prev")).toEqual({ zone: "a", index: 0 }); // bare: unknown count → 0
    expect(m.moveZone("prev")).toEqual({ zone: "c", index: 0 });
    expect(m.moveZone("prev")).toEqual({ zone: "b", index: 0 });
  });

  test("single-zone Tab returns to the origin slot", () => {
    const m = new KeyboardDragMachine();
    m.lift("x", [{ id: "only", count: 4 }], 2);
    m.move("next");
    expect(m.moveZone("next")).toEqual({ zone: "only", index: 2 });
  });

  test("malformed lift degrades: stays idle and returns false", () => {
    const m = new KeyboardDragMachine();
    expect(m.lift("x", [], 0)).toBe(false);
    expect(m.lift("", ["a"], 0)).toBe(false);
    expect(m.lift("x", ["a"], -1)).toBe(false);
    expect(m.lift("x", ["a"], 1.5)).toBe(false);
    expect(m.lift("x", [{ id: "a", count: 2 }], 2)).toBe(false); // index >= count
    expect(m.lift("x", ["a", "b"], 0, 2)).toBe(false); // origin out of range
    expect(m.lift("x", ["", { id: "" } as never, 5 as never], 0)).toBe(false); // all entries invalid
    expect(m.state).toBe("idle");
    // Invalid entries are filtered, valid ones remain
    expect(m.lift("x", ["", "ok"], 0)).toBe(true);
    expect(m.current()).toEqual({ zone: "ok", index: 0 });
  });

  test("lift while lifted is refused; reusable after drop", () => {
    const m = new KeyboardDragMachine();
    expect(m.lift("a", ["z"], 0)).toBe(true);
    expect(m.lift("b", ["z"], 0)).toBe(false);
    expect(m.current()).toEqual({ zone: "z", index: 0 });
    m.drop();
    expect(m.lift("b", ["w"], 3)).toBe(true);
    expect(m.origin()).toEqual({ zone: "w", index: 3 });
  });

  test("drop payload is a fresh object each time (not aliased to internals)", () => {
    const m = new KeyboardDragMachine();
    m.lift("a", [{ id: "z", count: 3 }], 0);
    const before = m.current()!;
    m.move("next");
    expect(before).toEqual({ zone: "z", index: 0 });
    const payload = m.drop()!;
    payload.to.index = 99;
    m.lift("a", [{ id: "z", count: 3 }], 0);
    expect(m.current()).toEqual({ zone: "z", index: 0 });
  });
});
