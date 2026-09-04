import { describe, expect, test } from "bun:test";
import { fixtureNames } from "../gallery-fixtures";
import { borderRadiusExample } from "./borderRadius";

describe("borderRadius gallery fixture", () => {
  test("tracks every rounded image in screenshot readiness", () => {
    expect([...fixtureNames(borderRadiusExample.ui)]).toEqual([
      "rounded-image-1.png",
      "rounded-image-2.png",
      "rounded-image-3.png",
    ]);
  });

  test("five radius samples fit the pinned Android content width", () => {
    const itemCount = 5;
    const itemWidth = 64;
    const gap = 8;
    const rowWidth = itemCount * itemWidth + (itemCount - 1) * gap;
    const androidLogicalWidth = 1080 / (420 / 160);
    const contentWidth = androidLogicalWidth - 2 * 24;

    expect(rowWidth).toBe(352);
    expect(rowWidth).toBeLessThanOrEqual(contentWidth);
    expect(itemCount * itemWidth + (itemCount - 1) * 12).toBeGreaterThan(contentWidth);

    const radiusSection = borderRadiusExample.ui.slice(
      borderRadiusExample.ui.indexOf('Text("Different radius values")'),
      borderRadiusExample.ui.indexOf('Text("With borders")'),
    );
    expect(radiusSection).toContain(".gap(8)");
    expect(radiusSection).not.toContain(".gap(12)");
  });
});
