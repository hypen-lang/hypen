import sharp from "sharp";

export interface GalleryReadinessStatus {
  ready: boolean;
  connected: boolean;
  initialTreeSent: boolean;
  generation: number;
  expectedFixtures: string[];
  loadedFixtures: string[];
}

export type GalleryPlatform = "ios" | "android" | "web" | "canvas" | "desktop";

export async function fetchGalleryReadiness(
  port: number,
  platform: GalleryPlatform,
  example: string,
): Promise<GalleryReadinessStatus> {
  const query = new URLSearchParams({ platform, example });
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness?${query}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Gallery readiness endpoint returned ${response.status}`);
  return response.json() as Promise<GalleryReadinessStatus>;
}

export async function waitForGalleryReadiness(
  port: number,
  platform: GalleryPlatform,
  example: string,
  previousGeneration: number,
  timeoutMs: number,
): Promise<GalleryReadinessStatus> {
  const startedAt = Date.now();
  let latest: GalleryReadinessStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await fetchGalleryReadiness(port, platform, example);
    if (latest.generation > previousGeneration && latest.ready) return latest;
    await Bun.sleep(100);
  }
  throw new Error(
    `Gallery did not become ready for ${platform}/${example}. ` +
    `Latest state: ${JSON.stringify(latest ?? null)}`,
  );
}

async function sample(path: string): Promise<Uint8Array> {
  const { data } = await sharp(path)
    .resize(96, 96, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

export interface VisualStabilityOptions {
  intervalMs?: number;
  maximumDelta?: number;
  requiredStableComparisons?: number;
}

/**
 * Indeterminate controls keep repainting after their layout is ready. Permit
 * that small, localized motion without weakening the loading/transition guard
 * used by every static gallery page.
 */
export function nativeGalleryStabilityOptions(example: string): VisualStabilityOptions {
  return example.toLowerCase() === "spinner" ? { maximumDelta: 0.002 } : {};
}

/** Add a stable stage label without hiding the underlying readiness error. */
export async function captureStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`, { cause: error });
  }
}

/**
 * Cross a browser paint boundary without assuming requestAnimationFrame runs.
 *
 * Headless Chromium can suspend animation frames when it considers the page
 * hidden. A bare double-rAF wait then never resolves and consumes the entire
 * screenshot deadline even though the DOM is ready. A short host-side settle
 * keeps the wait bounded; the following screenshot command performs the
 * actual browser paint capture.
 */
export async function waitForBrowserPaint(
  fallbackMs = 100,
): Promise<void> {
  // Keep this barrier entirely on the harness side. A hidden headless page may
  // suspend animation frames and its own timers; leaving a Runtime.evaluate
  // pending can also block the following screenshot command in Chromium.
  await Bun.sleep(fallbackMs);
}

export function normalizedPixelDelta(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error("Screenshot samples must have the same non-zero length");
  }
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference += Math.abs(a[index] - b[index]);
  }
  return difference / (a.length * 255);
}

/**
 * Wait for several consecutive equivalent frames. Requiring a run of stable
 * comparisons (rather than one arbitrary delay) lets native loading and route
 * transition frames clear while still returning quickly on a rendered page.
 */
export async function waitForSampleStability(
  readSample: () => Promise<Uint8Array>,
  timeoutMs: number,
  options: VisualStabilityOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 250;
  const maximumDelta = options.maximumDelta ?? 0.0005;
  const requiredStableComparisons = options.requiredStableComparisons ?? 3;
  if (requiredStableComparisons < 1) {
    throw new Error("Visual stability requires at least one stable comparison");
  }

  const startedAt = Date.now();
  let previous: Uint8Array | undefined;
  let stableComparisons = 0;
  let latestDelta: number | undefined;
  let smallestDelta = Number.POSITIVE_INFINITY;
  while (Date.now() - startedAt < timeoutMs) {
    const current = await readSample();
    latestDelta = previous ? normalizedPixelDelta(previous, current) : undefined;
    if (latestDelta !== undefined) smallestDelta = Math.min(smallestDelta, latestDelta);
    if (latestDelta !== undefined && latestDelta <= maximumDelta) {
      stableComparisons++;
      if (stableComparisons >= requiredStableComparisons) return;
    } else {
      stableComparisons = 0;
    }
    previous = current;
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    "Gallery content did not reach a stable rendered frame "
    + `(threshold ${maximumDelta}, latest ${latestDelta ?? "n/a"}, `
    + `smallest ${Number.isFinite(smallestDelta) ? smallestDelta : "n/a"})`,
  );
}

export async function waitForVisualStability(
  capture: (path: string) => Promise<void>,
  probePath: string,
  timeoutMs: number,
  options: VisualStabilityOptions = {},
): Promise<void> {
  await waitForSampleStability(async () => {
    await capture(probePath);
    return sample(probePath);
  }, timeoutMs, options);
}
