import { describe, expect, test } from "bun:test";
import { blurExample } from "./applicators/blur";
import { DEFAULT_SCREENSHOT_PROFILES } from "./screenshot-tests/screenshot-normalization";

const ITEM_COUNT = 4;
const ITEM_SIZE = 80;
const ITEM_GAP = 8;
const PAGE_HORIZONTAL_PADDING = 24;

describe("blur gallery layout", () => {
  test("keeps all four blur samples on one row at every pinned viewport width", () => {
    const blurAmountsSection = blurExample.ui
      .split('Text("Blur amounts")')[1]
      ?.split('Text("Blur on text/content")')[0];

    expect(blurAmountsSection).toBeDefined();
    expect(blurAmountsSection!.match(/\.width\(80\)/g)).toHaveLength(ITEM_COUNT);
    expect(blurAmountsSection).toContain(`.gap(${ITEM_GAP})`);

    const rowWidth = ITEM_COUNT * ITEM_SIZE + (ITEM_COUNT - 1) * ITEM_GAP;
    const pinnedContentWidths = Object.values(DEFAULT_SCREENSHOT_PROFILES).map(
      ({ expectedPixels, pixelsPerLogicalUnit }) =>
        expectedPixels.width / pixelsPerLogicalUnit - 2 * PAGE_HORIZONTAL_PADDING,
    );

    expect(rowWidth).toBe(344);
    expect(rowWidth).toBeLessThanOrEqual(Math.min(...pinnedContentWidths));
  });

  test("retains the full-width and 80-percent skeleton bars", () => {
    const skeletonSection = blurExample.ui.split('Text("Blur for loading/skeleton")')[1];

    expect(skeletonSection).toContain(".fillMaxWidth(true)");
    expect(skeletonSection).toContain('.width("80%")');
  });
});
