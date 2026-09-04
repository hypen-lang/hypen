import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  DEFAULT_SCREENSHOT_PROFILES,
  type ScreenshotProfiles,
  comparisonCanvas,
  normalizationGeometry,
  normalizeScreenshot,
} from "./screenshot-normalization";

describe("screenshot normalization geometry", () => {
  test("uses explicit native scale and current host chrome", () => {
    const ios = normalizationGeometry(DEFAULT_SCREENSHOT_PROFILES.ios);
    expect(ios.cropPixels).toEqual({ left: 0, top: 408, width: 1320, height: 2358 });
    expect(ios.logicalContent).toEqual({ width: 440, height: 786 });
    expect(ios.normalizedPixels).toEqual({ width: 440, height: 786 });

    const android = normalizationGeometry(DEFAULT_SCREENSHOT_PROFILES.android);
    expect(android.cropPixels).toEqual({ left: 0, top: 305, width: 1080, height: 2032 });
    expect(android.logicalContent.width).toBeCloseTo(411.428571, 5);
    expect(android.logicalContent.height).toBeCloseTo(774.095238, 5);
    expect(android.normalizedPixels).toEqual({ width: 411, height: 773 });

    expect(comparisonCanvas(DEFAULT_SCREENSHOT_PROFILES)).toEqual({ width: 440, height: 934 });
  });

  test("rejects screenshots outside the configured device dimensions", async () => {
    const wrongSize = await sharp({
      create: { width: 10, height: 10, channels: 4, background: "white" },
    }).png().toBuffer();

    await expect(normalizeScreenshot(wrongSize, "ios")).rejects.toThrow(
      "ios screenshot is 10x10; expected 1320x2868",
    );
  });

  test("crops in native pixels, scales uniformly, and anchors on a common canvas", async () => {
    const profiles: ScreenshotProfiles = {
      web: {
        expectedPixels: { width: 4, height: 5 },
        pixelsPerLogicalUnit: 1,
        chrome: { top: 0, bottom: 0 },
      },
      canvas: {
        expectedPixels: { width: 4, height: 5 },
        pixelsPerLogicalUnit: 1,
        chrome: { top: 0, bottom: 0 },
      },
      desktop: {
        expectedPixels: { width: 4, height: 5 },
        pixelsPerLogicalUnit: 1,
        chrome: { top: 0, bottom: 0 },
      },
      ios: {
        expectedPixels: { width: 6, height: 8 },
        pixelsPerLogicalUnit: 2,
        chrome: { top: 1, bottom: 1 },
      },
      android: {
        expectedPixels: { width: 6, height: 9 },
        pixelsPerLogicalUnit: 3,
        chrome: { top: 1, bottom: 0 },
      },
    };
    const canvas = comparisonCanvas(profiles);
    expect(canvas).toEqual({ width: 4, height: 5 });

    const source = await sharp({
      create: { width: 6, height: 8, channels: 4, background: "#00ff00" },
    })
      .composite([{
        input: {
          create: { width: 6, height: 2, channels: 4, background: "#ff0000" },
        },
        left: 0,
        top: 0,
      }])
      .png()
      .toBuffer();
    const normalized = await normalizeScreenshot(source, "ios", profiles, canvas);

    expect(normalized.byteLength).toBe(4 * 5 * 4);
    const pixel = (x: number, y: number) => [...normalized.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(pixel(0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(2, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(3, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(0, 2)).toEqual([255, 255, 255, 255]);
  });
});
