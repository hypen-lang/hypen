/**
 * Canvas applicator-prop normalisation tests.
 *
 * The engine sends props in applicator-argument form (`flex.0`, `padding.0`,
 * `onClick.0`, `onClick.to`). Without normalisation, canvas/layout.ts reads
 * flat keys (`flex`, `padding`) and every size/flex prop is silently ignored,
 * which collapses the whole layout — e.g. a single avatar painted at the full
 * canvas bounds instead of 56×56.
 */

import { test, expect, describe } from "bun:test";
import {
  parseApplicatorBase,
  refreshApplicator,
  normalizeAllApplicators,
  resolveEventAction,
} from "../packages/web/src/canvas/props.js";
import {
  cssLengthToPx,
  cssLengthToDimension,
  parseSpacing,
  parseSize,
} from "../packages/web/src/canvas/utils.js";

describe("cssLengthToPx", () => {
  test("handles plain numbers", () => {
    expect(cssLengthToPx(42)).toBe(42);
    expect(cssLengthToPx(0)).toBe(0);
  });

  test("reads px/unitless as pixels", () => {
    expect(cssLengthToPx("16")).toBe(16);
    expect(cssLengthToPx("16px")).toBe(16);
  });

  test("converts rem and em at 16px root", () => {
    expect(cssLengthToPx("1rem")).toBe(16);
    expect(cssLengthToPx("3.5rem")).toBe(56);
    expect(cssLengthToPx("0.75rem")).toBe(12);
    expect(cssLengthToPx("1em")).toBe(16);
  });

  test("returns null for percentages and auto", () => {
    expect(cssLengthToPx("100%")).toBeNull();
    expect(cssLengthToPx("auto")).toBeNull();
    expect(cssLengthToPx("")).toBeNull();
    expect(cssLengthToPx(undefined)).toBeNull();
  });
});

describe("cssLengthToDimension", () => {
  test("keeps percentages verbatim", () => {
    expect(cssLengthToDimension("100%")).toBe("100%");
    expect(cssLengthToDimension("50%")).toBe("50%");
  });

  test("converts rem into pixels", () => {
    expect(cssLengthToDimension("3.5rem")).toBe(56);
  });

  test("returns 'auto' for null/undefined/auto input", () => {
    expect(cssLengthToDimension(undefined)).toBe("auto");
    expect(cssLengthToDimension(null)).toBe("auto");
    expect(cssLengthToDimension("auto")).toBe("auto");
  });
});

describe("parseSpacing (CSS-aware)", () => {
  test("handles a single rem string as shorthand for all sides", () => {
    expect(parseSpacing("1rem")).toEqual({ top: 16, right: 16, bottom: 16, left: 16 });
  });

  test("handles positional applicator arg form with rem values", () => {
    expect(parseSpacing({ "0": "0.5rem", "1": "1rem" })).toEqual({
      top: 8, right: 16, bottom: 8, left: 16,
    });
  });
});

describe("parseSize", () => {
  test("converts rem strings into pixel sizes", () => {
    expect(parseSize("3.5rem")).toBe(56);
  });
});

describe("parseApplicatorBase", () => {
  test("returns null for flat keys", () => {
    expect(parseApplicatorBase("flex")).toBeNull();
    expect(parseApplicatorBase("__iconPaths")).toBeNull();
    expect(parseApplicatorBase("0")).toBeNull();
  });

  test("extracts base before first dot", () => {
    expect(parseApplicatorBase("flex.0")).toBe("flex");
    expect(parseApplicatorBase("onClick.to")).toBe("onClick");
    expect(parseApplicatorBase("padding.1")).toBe("padding");
  });

  test("returns null when the dot is at position 0", () => {
    // Defensive: a leading dot is not an applicator.
    expect(parseApplicatorBase(".foo")).toBeNull();
  });
});

describe("refreshApplicator", () => {
  test("flattens a single positional arg into the scalar value", () => {
    const props: Record<string, any> = { "flex.0": "1" };
    refreshApplicator(props, "flex");
    expect(props.flex).toBe("1");
  });

  test("aggregates multi-argument applicators into an object", () => {
    const props: Record<string, any> = {
      "onClick.0": "@router.push",
      "onClick.to": "/notifications",
    };
    refreshApplicator(props, "onClick");
    expect(props.onClick).toEqual({ "0": "@router.push", to: "/notifications" });
  });

  test("deletes stale aggregate when every namespaced key is gone", () => {
    const props: Record<string, any> = { flex: "1" };
    refreshApplicator(props, "flex");
    expect(props.flex).toBeUndefined();
  });

  test("does not touch unrelated bases", () => {
    const props: Record<string, any> = { "flex.0": "1", "padding.0": "16" };
    refreshApplicator(props, "flex");
    expect(props.flex).toBe("1");
    expect(props.padding).toBeUndefined();
    expect(props["padding.0"]).toBe("16");
  });
});

describe("normalizeAllApplicators", () => {
  test("flattens every applicator base in one pass", () => {
    const props: Record<string, any> = {
      "flex.0": "1",
      "width.0": "100%",
      "padding.0": "1rem",
      "onClick.0": "@router.push",
      "onClick.to": "/notifications",
      "0": "Hypengram", // Text positional — not namespaced, must be left alone
      __iconPaths: [{ d: "M0 0" }],
    };
    normalizeAllApplicators(props);

    expect(props.flex).toBe("1");
    expect(props.width).toBe("100%");
    expect(props.padding).toBe("1rem");
    expect(props.onClick).toEqual({ "0": "@router.push", to: "/notifications" });
    expect(props["0"]).toBe("Hypengram");
    expect(props.__iconPaths).toEqual([{ d: "M0 0" }]);
  });

  test("is a no-op when no keys are namespaced", () => {
    const props: Record<string, any> = { flex: "1", padding: 10 };
    const snapshot = { ...props };
    normalizeAllApplicators(props);
    expect(props).toEqual(snapshot);
  });

  test("preserves raw namespaced keys so follow-up setProp patches can re-aggregate", () => {
    const props: Record<string, any> = {
      "onClick.0": "@router.push",
      "onClick.to": "/a",
    };
    normalizeAllApplicators(props);

    // Simulate an engine SetProp patch that swaps the destination path.
    props["onClick.to"] = "/b";
    refreshApplicator(props, "onClick");

    expect(props.onClick).toEqual({ "0": "@router.push", to: "/b" });
  });
});

describe("resolveEventAction", () => {
  test("strips the leading @ from string specs", () => {
    // The DSL writes `@submit` but the engine wants `submit` on the wire.
    // Without stripping, every action was sent prefixed and the engine
    // silently dropped it (router.push, in particular, was visibly broken).
    expect(resolveEventAction("@submit")).toEqual({ actionName: "submit", payload: {} });
  });

  test("strips both @ and the actions. namespace", () => {
    expect(resolveEventAction("@actions.toggleLike")).toEqual({
      actionName: "toggleLike",
      payload: {},
    });
  });

  test("strips the @ from the aggregate-form action and keeps the rest as payload", () => {
    const spec = { "0": "@router.push", to: "/notifications" };
    expect(resolveEventAction(spec)).toEqual({
      actionName: "router.push",
      payload: { to: "/notifications" },
    });
  });

  test("returns null when no @-prefixed string action is present", () => {
    expect(resolveEventAction(null)).toBeNull();
    expect(resolveEventAction(undefined)).toBeNull();
    expect(resolveEventAction({ to: "/foo" })).toBeNull(); // no "0" key
    expect(resolveEventAction(42)).toBeNull();
    // Unprefixed strings/values are NOT actions — the DOM renderer drops
    // them too (see `extractActionDetails`).
    expect(resolveEventAction("plain")).toBeNull();
    expect(resolveEventAction({ "0": "plain", x: 1 })).toBeNull();
  });
});
