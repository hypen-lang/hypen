import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import {
  CONTACT_SHEET_PLATFORMS,
  createPlatformContactSheet,
} from "./comparison-contact-sheet";

describe("platform comparison contact sheet", () => {
  test("places all platforms in the requested order without a diff panel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hypen-contact-sheet-"));
    const output = join(directory, "sheet.png");
    const colors = {
      ios: [255, 0, 0, 255],
      android: [0, 255, 0, 255],
      web: [0, 0, 255, 255],
      desktop: [255, 255, 0, 255],
      canvas: [255, 0, 255, 255],
    } as const;

    try {
      await createPlatformContactSheet(
        Object.fromEntries(
          CONTACT_SHEET_PLATFORMS.map(platform => [platform, Buffer.from(colors[platform])]),
        ),
        1,
        1,
        output,
      );

      const { data, info } = await sharp(output).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(5);
      expect(info.height).toBe(31);
      expect(CONTACT_SHEET_PLATFORMS).toEqual(["ios", "android", "web", "desktop", "canvas"]);
      expect(Array.from(data.subarray(30 * 5 * 4, 31 * 5 * 4))).toEqual(
        CONTACT_SHEET_PLATFORMS.flatMap(platform => [...colors[platform]]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses each platform's logical width instead of showing comparison-canvas gutters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hypen-contact-sheet-widths-"));
    const output = join(directory, "sheet.png");
    const rgba = Buffer.alloc(4 * 4 * 2, 255);

    try {
      await createPlatformContactSheet(
        Object.fromEntries(CONTACT_SHEET_PLATFORMS.map(platform => [platform, rgba])),
        4,
        2,
        output,
        {
          ios: { width: 4, height: 2 },
          android: { width: 2, height: 2 },
          web: { width: 3, height: 2 },
          desktop: { width: 3, height: 2 },
          canvas: { width: 3, height: 2 },
        },
      );

      const metadata = await sharp(output).metadata();
      expect(metadata.width).toBe(15);
      expect(metadata.height).toBe(32);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
