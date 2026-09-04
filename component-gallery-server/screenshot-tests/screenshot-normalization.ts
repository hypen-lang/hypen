import sharp from "sharp";

export type ScreenshotPlatform = "web" | "canvas" | "desktop" | "ios" | "android";

export interface ScreenshotProfile {
  /** Exact full-screen PNG dimensions produced by the pinned device. */
  expectedPixels: { width: number; height: number };
  /** Native pixels per CSS pixel, iOS point, or Android dp. */
  pixelsPerLogicalUnit: number;
  /** Host UI removed before comparing gallery content, expressed in logical units. */
  chrome: { top: number; bottom: number; left?: number; right?: number };
}

export type ScreenshotProfiles = Record<ScreenshotPlatform, ScreenshotProfile>;

/**
 * Capture profiles for the devices pinned by run-tests.ts.
 *
 * Chrome values describe the preview containers, not the rendered Hypen tree:
 * - iOS: component sheet/status/navigation region and home-indicator inset.
 * - Android: status bar + gallery preview toolbar and 24dp gesture navigation bar.
 * - Web: the browser captures the renderer viewport directly.
 */
export const DEFAULT_SCREENSHOT_PROFILES: ScreenshotProfiles = {
  web: {
    expectedPixels: { width: 430, height: 934 },
    pixelsPerLogicalUnit: 1,
    chrome: { top: 0, bottom: 0 },
  },
  canvas: {
    expectedPixels: { width: 430, height: 934 },
    pixelsPerLogicalUnit: 1,
    chrome: { top: 0, bottom: 0 },
  },
  desktop: {
    expectedPixels: { width: 430, height: 934 },
    pixelsPerLogicalUnit: 1,
    chrome: { top: 0, bottom: 0 },
  },
  ios: {
    expectedPixels: { width: 1320, height: 2868 },
    pixelsPerLogicalUnit: 3,
    chrome: { top: 136, bottom: 34 },
  },
  android: {
    expectedPixels: { width: 1080, height: 2400 },
    pixelsPerLogicalUnit: 420 / 160,
    chrome: { top: 116, bottom: 24 },
  },
};

export interface NormalizationGeometry {
  sourcePixels: { width: number; height: number };
  cropPixels: { left: number; top: number; width: number; height: number };
  logicalContent: { width: number; height: number };
  normalizedPixels: { width: number; height: number };
}

export interface ComparisonCanvas {
  width: number;
  height: number;
}

function positiveFinite(value: number, description: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${description} must be a positive finite number; received ${value}`);
  }
}

function insetPixels(value: number | undefined, scale: number, description: string): number {
  const logicalValue = value ?? 0;
  if (!Number.isFinite(logicalValue) || logicalValue < 0) {
    throw new Error(`${description} must be a non-negative finite number; received ${logicalValue}`);
  }
  // Android densities need not map a whole dp to a whole physical pixel
  // (420dpi is 2.625px/dp). Device chrome is still specified in dp; use the
  // same nearest-pixel rasterization as the platform rather than rejecting
  // valid half-pixel logical boundaries.
  return Math.round(logicalValue * scale);
}

export function normalizationGeometry(profile: ScreenshotProfile): NormalizationGeometry {
  const { width, height } = profile.expectedPixels;
  positiveFinite(width, "Screenshot width");
  positiveFinite(height, "Screenshot height");
  positiveFinite(profile.pixelsPerLogicalUnit, "Pixel scale");

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`Screenshot dimensions must be whole pixels; received ${width}x${height}`);
  }

  const left = insetPixels(profile.chrome.left, profile.pixelsPerLogicalUnit, "Left chrome inset");
  const right = insetPixels(profile.chrome.right, profile.pixelsPerLogicalUnit, "Right chrome inset");
  const top = insetPixels(profile.chrome.top, profile.pixelsPerLogicalUnit, "Top chrome inset");
  const bottom = insetPixels(profile.chrome.bottom, profile.pixelsPerLogicalUnit, "Bottom chrome inset");
  const contentWidth = width - left - right;
  const contentHeight = height - top - bottom;

  if (contentWidth <= 0 || contentHeight <= 0) {
    throw new Error(
      `Chrome insets consume the screenshot: ${width}x${height} with `
      + `${left},${top},${right},${bottom}px insets`,
    );
  }

  const logicalWidth = contentWidth / profile.pixelsPerLogicalUnit;
  const logicalHeight = contentHeight / profile.pixelsPerLogicalUnit;
  // Raster output must be integral. Select width from the explicit logical scale,
  // then derive height from the cropped image's aspect ratio so x/y are never
  // stretched by different factors.
  const normalizedWidth = Math.max(1, Math.round(logicalWidth));
  const normalizedHeight = Math.max(1, Math.round(contentHeight * normalizedWidth / contentWidth));

  return {
    sourcePixels: { width, height },
    cropPixels: { left, top, width: contentWidth, height: contentHeight },
    logicalContent: { width: logicalWidth, height: logicalHeight },
    normalizedPixels: { width: normalizedWidth, height: normalizedHeight },
  };
}

export function comparisonCanvas(profiles: ScreenshotProfiles): ComparisonCanvas {
  const geometries = Object.values(profiles).map(normalizationGeometry);
  return {
    width: Math.max(...geometries.map(item => item.normalizedPixels.width)),
    height: Math.max(...geometries.map(item => item.normalizedPixels.height)),
  };
}

export async function normalizeScreenshot(
  input: string | Buffer,
  platform: ScreenshotPlatform,
  profiles: ScreenshotProfiles = DEFAULT_SCREENSHOT_PROFILES,
  canvas: ComparisonCanvas = comparisonCanvas(profiles),
): Promise<Buffer> {
  const profile = profiles[platform];
  const geometry = normalizationGeometry(profile);
  const metadata = await sharp(input).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read ${platform} screenshot dimensions`);
  }
  if (
    metadata.width !== geometry.sourcePixels.width
    || metadata.height !== geometry.sourcePixels.height
  ) {
    throw new Error(
      `${platform} screenshot is ${metadata.width}x${metadata.height}; expected `
      + `${geometry.sourcePixels.width}x${geometry.sourcePixels.height} from the configured device profile`,
    );
  }
  if (
    canvas.width < geometry.normalizedPixels.width
    || canvas.height < geometry.normalizedPixels.height
  ) {
    throw new Error(
      `Comparison canvas ${canvas.width}x${canvas.height} cannot contain ${platform} content `
      + `${geometry.normalizedPixels.width}x${geometry.normalizedPixels.height}`,
    );
  }

  const { data, info } = await sharp(input)
    .extract(geometry.cropPixels)
    // Width-only resizing guarantees one uniform scale factor. Sharp derives
    // height from the cropped aspect ratio instead of stretching to a box.
    .resize({ width: geometry.normalizedPixels.width, kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (
    info.width !== geometry.normalizedPixels.width
    || info.height !== geometry.normalizedPixels.height
  ) {
    throw new Error(
      `Unexpected normalized ${platform} geometry: ${info.width}x${info.height}; expected `
      + `${geometry.normalizedPixels.width}x${geometry.normalizedPixels.height}`,
    );
  }

  // Anchor every renderer's content origin at (0, 0). A white common canvas
  // preserves narrower/shorter viewport geometry without inventing a stretch.
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{
      input: data,
      raw: { width: info.width, height: info.height, channels: 4 },
      left: 0,
      top: 0,
    }])
    .ensureAlpha()
    .raw()
    .toBuffer();
}
