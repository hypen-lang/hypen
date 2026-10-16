/**
 * The renderer-side window math from docs/virtualization.md. Native
 * renderers port these functions; keep their tests aligned with this file.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ITEM_SIZE,
  childrenPerItem,
  itemSize,
  parseVirtWindow,
  shouldReport,
  visibleRange,
  viewportReport,
  wantedRange,
  windowPadding,
  windowRows,
} from "../packages/core/src/virtualization";

describe("parseVirtWindow", () => {
  test("decodes the engine's prop", () => {
    expect(parseVirtWindow({ total: 100, start: 10, end: 40 })).toEqual({
      total: 100,
      start: 10,
      end: 40,
    });
    expect(parseVirtWindow({ total: 5, start: 0, end: 2, estimatedSize: 48 })).toEqual({
      total: 5,
      start: 0,
      end: 2,
      estimatedSize: 48,
    });
  });

  test("rejects malformed values", () => {
    expect(parseVirtWindow(null)).toBeNull();
    expect(parseVirtWindow({ total: 10, start: 5, end: 3 })).toBeNull();
    expect(parseVirtWindow({ total: 10, start: 0, end: 11 })).toBeNull();
    expect(parseVirtWindow({ total: 10, start: -1, end: 3 })).toBeNull();
    expect(parseVirtWindow({ total: "10", start: 0, end: 3 })).toBeNull();
  });
});

describe("itemSize", () => {
  const w = { total: 100, start: 0, end: 10 };
  test("prefers the measured average", () => {
    expect(itemSize({ ...w, estimatedSize: 30 }, 500, 10)).toBe(50);
  });
  test("falls back to the estimate, then the default", () => {
    expect(itemSize({ ...w, estimatedSize: 30 }, 0, 0)).toBe(30);
    expect(itemSize(w, 0, 0)).toBe(DEFAULT_ITEM_SIZE);
  });
});

describe("windowPadding", () => {
  test("stands in for the items outside the window", () => {
    expect(windowPadding({ total: 100, start: 40, end: 70 }, 10)).toEqual({
      leading: 400,
      trailing: 300,
    });
  });
  test("is zero when the window covers everything", () => {
    expect(windowPadding({ total: 5, start: 0, end: 5 }, 10)).toEqual({
      leading: 0,
      trailing: 0,
    });
  });
  test("counts grid rows", () => {
    // 3 columns: items 0..8 are rows 0..2; window 9..18 is rows 3..5; 30 items = 10 rows.
    expect(windowPadding({ total: 30, start: 9, end: 18 }, 100, 3)).toEqual({
      leading: 300,
      trailing: 400,
    });
  });
});

describe("windowRows", () => {
  test("is the item count for a list", () => {
    expect(windowRows({ total: 100, start: 40, end: 70 })).toBe(30);
  });
  test("counts every grid row the window touches", () => {
    expect(windowRows({ total: 30, start: 9, end: 18 }, 3)).toBe(3);
    expect(windowRows({ total: 30, start: 10, end: 17 }, 3)).toBe(3);
  });
});

describe("childrenPerItem", () => {
  test("groups a multi-node template's children into items", () => {
    expect(childrenPerItem({ total: 100, start: 10, end: 20 }, 10)).toBe(1);
    expect(childrenPerItem({ total: 100, start: 10, end: 20 }, 30)).toBe(3);
  });
  test("is at least 1", () => {
    expect(childrenPerItem({ total: 100, start: 10, end: 10 }, 0)).toBe(1);
    expect(childrenPerItem({ total: 100, start: 10, end: 20 }, 0)).toBe(1);
  });
});

describe("visibleRange", () => {
  test("maps the scroll offset to items", () => {
    expect(visibleRange(1000, 50, 500, 200)).toEqual({ start: 10, end: 14 });
  });
  test("clamps to the list", () => {
    expect(visibleRange(12, 50, 500, 200)).toEqual({ start: 10, end: 12 });
    expect(visibleRange(100, 50, -300, 200)).toEqual({ start: 0, end: 4 });
  });
  test("counts grid rows", () => {
    expect(visibleRange(90, 100, 300, 200, 3)).toEqual({ start: 9, end: 15 });
  });
});

describe("wantedRange", () => {
  test("adds a viewport of overscan on each side", () => {
    expect(wantedRange({ start: 40, end: 60 }, 1000)).toEqual({ start: 20, end: 80 });
  });
  test("overscans at least five items", () => {
    expect(wantedRange({ start: 40, end: 42 }, 1000)).toEqual({ start: 35, end: 47 });
  });
  test("clamps to the list", () => {
    expect(wantedRange({ start: 2, end: 10 }, 12)).toEqual({ start: 0, end: 12 });
  });
});

describe("shouldReport", () => {
  const window = { total: 1000, start: 20, end: 80 };
  test("not while the visible range is covered", () => {
    expect(shouldReport(window, { start: 40, end: 60 }, { start: 20, end: 80 }, null)).toBe(false);
  });
  test("when the visible range leaves the window", () => {
    expect(shouldReport(window, { start: 70, end: 90 }, { start: 50, end: 110 }, null)).toBe(true);
  });
  test("when the window is far larger than needed", () => {
    const wide = { total: 1000, start: 0, end: 500 };
    expect(shouldReport(wide, { start: 100, end: 110 }, { start: 90, end: 120 }, null)).toBe(true);
  });
  test("never the same range twice", () => {
    const wanted = { start: 50, end: 110 };
    expect(shouldReport(window, { start: 70, end: 90 }, wanted, wanted)).toBe(false);
  });
});

describe("viewportReport", () => {
  const window = { total: 1000, start: 0, end: 20 };
  test("nothing while the window covers the visible range", () => {
    expect(viewportReport(window, { size: 50, scrolledPast: 0, viewportExtent: 500 }, null)).toBeNull();
  });
  test("the overscanned range once the user scrolls past the window", () => {
    const geometry = { size: 50, scrolledPast: 2000, viewportExtent: 500 };
    // visible [40,50) → one viewport (10 items) of overscan each side.
    expect(viewportReport(window, geometry, null)).toEqual({ start: 30, end: 60 });
    expect(viewportReport(window, geometry, { start: 30, end: 60 })).toBeNull();
  });
  test("counts only the part of the viewport over a list that starts below its top", () => {
    const short = { total: 1000, start: 0, end: 2 };
    // The list starts 100px down a 300px viewport: 200px (4 items) of it shows.
    expect(viewportReport(short, { size: 50, scrolledPast: -100, viewportExtent: 300 }, null)).toEqual({
      start: 0,
      end: 9,
    });
    // Entirely below the viewport: nothing is visible, nothing to report.
    expect(viewportReport(short, { size: 50, scrolledPast: -400, viewportExtent: 300 }, null)).toBeNull();
  });
  test("grids report whole rows", () => {
    const grid = { total: 90, start: 0, end: 9 };
    expect(viewportReport(grid, { size: 100, scrolledPast: 300, viewportExtent: 200, columns: 3 }, null)).toEqual({
      start: 3,
      end: 21,
    });
  });
});
