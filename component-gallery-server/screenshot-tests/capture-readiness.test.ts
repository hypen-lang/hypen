import { describe, expect, test } from "bun:test";
import {
  captureStage,
  nativeGalleryStabilityOptions,
  normalizedPixelDelta,
  waitForBrowserPaint,
  waitForSampleStability,
} from "./capture-readiness";

describe("capture readiness", () => {
  test("allows bounded motion only for the indeterminate spinner page", () => {
    expect(nativeGalleryStabilityOptions("spinner")).toEqual({ maximumDelta: 0.002 });
    expect(nativeGalleryStabilityOptions("Spinner")).toEqual({ maximumDelta: 0.002 });
    expect(nativeGalleryStabilityOptions("progressbar")).toEqual({});
  });

  test("measures normalized pixel changes", () => {
    expect(normalizedPixelDelta(
      Uint8Array.from([0, 100, 255]),
      Uint8Array.from([0, 100, 255]),
    )).toBe(0);
    expect(normalizedPixelDelta(
      Uint8Array.from([0, 0]),
      Uint8Array.from([255, 255]),
    )).toBe(1);
  });

  test("rejects incompatible samples", () => {
    expect(() => normalizedPixelDelta(new Uint8Array(), new Uint8Array())).toThrow();
    expect(() => normalizedPixelDelta(Uint8Array.of(1), Uint8Array.of(1, 2))).toThrow();
  });

  test("waits through a loading-to-content transition and requires a stable run", async () => {
    const loading = Uint8Array.of(10, 10, 10);
    const content = Uint8Array.of(220, 220, 220);
    const frames = [loading, loading, content, content, content, content];
    let reads = 0;

    await waitForSampleStability(
      async () => frames[Math.min(reads++, frames.length - 1)],
      100,
      { intervalMs: 0, requiredStableComparisons: 3 },
    );

    expect(reads).toBe(6);
  });

  test("does not accept a continuously changing transition", async () => {
    let frame = 0;
    await expect(waitForSampleStability(
      async () => Uint8Array.of((frame++ % 2) * 255),
      10,
      { intervalMs: 1, requiredStableComparisons: 2 },
    )).rejects.toThrow("did not reach a stable rendered frame");
  });

  test("rejects an invalid stable comparison count", async () => {
    await expect(waitForSampleStability(
      async () => Uint8Array.of(0),
      10,
      { requiredStableComparisons: 0 },
    )).rejects.toThrow("at least one stable comparison");
  });

  test("labels the failed capture stage without hiding its cause", async () => {
    await expect(captureStage("iOS/justifyContent readiness", async () => {
      throw new Error("generation did not advance");
    })).rejects.toThrow("iOS/justifyContent readiness: generation did not advance");
  });

  test("browser paint wait stays bounded outside the page runtime", async () => {
    await waitForBrowserPaint(1);
  });
});
