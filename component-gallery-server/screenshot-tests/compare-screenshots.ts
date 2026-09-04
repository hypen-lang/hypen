#!/usr/bin/env bun
/**
 * Screenshot Comparison Tool
 *
 * Compares screenshots across Web DOM, Canvas, Desktop, iOS, and Android.
 * Handles different screen dimensions and toolbar cropping.
 *
 * Usage:
 *   bun run compare-screenshots.ts [options]
 *
 * Options:
 *   --component=X    Compare only a specific component
 *   --threshold=X    Pixel difference threshold 0-1 (default: 0.1)
 *   --output=dir     Output directory for five-platform strips (default: results/diffs)
 *   --allow-differences  Exit successfully after producing output even below similarity targets
 *   --ios-width/--ios-height/--ios-scale/--ios-crop-top/--ios-crop-bottom=X
 *   --android-width/--android-height/--android-density/--android-crop-top/--android-crop-bottom=X
 *   --web-width/--web-height=X
 *   --canvas-width/--canvas-height=X
 *   --desktop-width/--desktop-height=X
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { registeredGalleryDeeplinks } from "./gallery-registry";
import {
  CONTACT_SHEET_PLATFORMS,
  createPlatformContactSheet,
} from "./comparison-contact-sheet";
import {
  DEFAULT_SCREENSHOT_PROFILES,
  type ScreenshotProfiles,
  comparisonCanvas,
  normalizeScreenshot,
  normalizationGeometry,
} from "./screenshot-normalization";

// Configuration
const SCRIPT_DIR = dirname(import.meta.path);
const RESULTS_DIR = join(SCRIPT_DIR, "results");

// Parse arguments
const args = process.argv.slice(2);
const allowDifferences = args.includes("--allow-differences");
function numericOption(
  name: string,
  environmentValue: string | undefined,
  fallback: number,
  allowZero = false,
): number {
  const argument = args.find(value => value.startsWith(`--${name}=`));
  const raw = argument?.slice(name.length + 3) ?? environmentValue;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`--${name} must be ${allowZero ? "non-negative" : "positive"}; received ${raw}`);
  }
  return value;
}

// These values deliberately use the same native dimension/density option names
// as run-tests.ts. Chrome insets are logical CSS px/points/dp, never raw pixels.
const PLATFORM_CONFIG = {
  web: {
    expectedPixels: {
      width: numericOption(
        "web-width",
        process.env.HYPEN_WEB_WIDTH,
        DEFAULT_SCREENSHOT_PROFILES.web.expectedPixels.width,
      ),
      height: numericOption(
        "web-height",
        process.env.HYPEN_WEB_HEIGHT,
        DEFAULT_SCREENSHOT_PROFILES.web.expectedPixels.height,
      ),
    },
    pixelsPerLogicalUnit: DEFAULT_SCREENSHOT_PROFILES.web.pixelsPerLogicalUnit,
    chrome: DEFAULT_SCREENSHOT_PROFILES.web.chrome,
  },
  canvas: {
    expectedPixels: {
      width: numericOption(
        "canvas-width",
        process.env.HYPEN_CANVAS_WIDTH,
        DEFAULT_SCREENSHOT_PROFILES.canvas.expectedPixels.width,
      ),
      height: numericOption(
        "canvas-height",
        process.env.HYPEN_CANVAS_HEIGHT,
        DEFAULT_SCREENSHOT_PROFILES.canvas.expectedPixels.height,
      ),
    },
    pixelsPerLogicalUnit: DEFAULT_SCREENSHOT_PROFILES.canvas.pixelsPerLogicalUnit,
    chrome: DEFAULT_SCREENSHOT_PROFILES.canvas.chrome,
  },
  desktop: {
    expectedPixels: {
      width: numericOption(
        "desktop-width",
        process.env.HYPEN_DESKTOP_WIDTH,
        DEFAULT_SCREENSHOT_PROFILES.desktop.expectedPixels.width,
      ),
      height: numericOption(
        "desktop-height",
        process.env.HYPEN_DESKTOP_HEIGHT,
        DEFAULT_SCREENSHOT_PROFILES.desktop.expectedPixels.height,
      ),
    },
    pixelsPerLogicalUnit: DEFAULT_SCREENSHOT_PROFILES.desktop.pixelsPerLogicalUnit,
    chrome: DEFAULT_SCREENSHOT_PROFILES.desktop.chrome,
  },
  ios: {
    expectedPixels: {
      width: numericOption(
        "ios-width",
        process.env.HYPEN_IOS_WIDTH,
        DEFAULT_SCREENSHOT_PROFILES.ios.expectedPixels.width,
      ),
      height: numericOption(
        "ios-height",
        process.env.HYPEN_IOS_HEIGHT,
        DEFAULT_SCREENSHOT_PROFILES.ios.expectedPixels.height,
      ),
    },
    pixelsPerLogicalUnit: numericOption(
      "ios-scale",
      process.env.HYPEN_IOS_SCALE,
      DEFAULT_SCREENSHOT_PROFILES.ios.pixelsPerLogicalUnit,
    ),
    chrome: {
      top: numericOption(
        "ios-crop-top",
        process.env.HYPEN_IOS_CROP_TOP,
        DEFAULT_SCREENSHOT_PROFILES.ios.chrome.top,
        true,
      ),
      bottom: numericOption(
        "ios-crop-bottom",
        process.env.HYPEN_IOS_CROP_BOTTOM,
        DEFAULT_SCREENSHOT_PROFILES.ios.chrome.bottom,
        true,
      ),
    },
  },
  android: {
    expectedPixels: {
      width: numericOption(
        "android-width",
        process.env.HYPEN_ANDROID_WIDTH,
        DEFAULT_SCREENSHOT_PROFILES.android.expectedPixels.width,
      ),
      height: numericOption(
        "android-height",
        process.env.HYPEN_ANDROID_HEIGHT,
        DEFAULT_SCREENSHOT_PROFILES.android.expectedPixels.height,
      ),
    },
    pixelsPerLogicalUnit:
      numericOption(
        "android-density",
        process.env.HYPEN_ANDROID_DENSITY,
        DEFAULT_SCREENSHOT_PROFILES.android.pixelsPerLogicalUnit * 160,
      ) / 160,
    chrome: {
      top: numericOption(
        "android-crop-top",
        process.env.HYPEN_ANDROID_CROP_TOP,
        DEFAULT_SCREENSHOT_PROFILES.android.chrome.top,
        true,
      ),
      bottom: numericOption(
        "android-crop-bottom",
        process.env.HYPEN_ANDROID_CROP_BOTTOM,
        DEFAULT_SCREENSHOT_PROFILES.android.chrome.bottom,
        true,
      ),
    },
  },
} satisfies ScreenshotProfiles;
const COMPARISON_CANVAS = comparisonCanvas(PLATFORM_CONFIG);
const TARGET_WIDTH = COMPARISON_CANVAS.width;
const TARGET_HEIGHT = COMPARISON_CANVAS.height;

const componentArg = args.find(a => a.startsWith("--component="));
const specificComponent = componentArg ? componentArg.split("=")[1] : null;
const thresholdArg = args.find(a => a.startsWith("--threshold="));
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.1;
const outputArg = args.find(a => a.startsWith("--output="));
const DIFF_DIR = outputArg ? outputArg.split("=")[1] : join(RESULTS_DIR, "diffs");

interface ComparisonResult {
  component: string;
  contactSheetPath: string;
  comparisons: {
    pair: string;
    diffPercent: number;
    diffPixels: number;
    totalPixels: number;
    ssimScore: number;  // 0-1, higher = more similar
  }[];
  missingPlatforms: string[];
  invalidPlatforms: { platform: string; error: string }[];
}

/**
 * Calculate perceptual color difference using CIE76 Delta E
 * More accurate than simple RGB distance for human perception
 */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // RGB to XYZ
  let rr = r / 255;
  let gg = g / 255;
  let bb = b / 255;

  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

  const x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047;
  const y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.0;
  const z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883;

  // XYZ to Lab
  const fx = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + 16/116;
  const fy = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + 16/116;
  const fz = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + 16/116;

  const L = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const bVal = 200 * (fy - fz);

  return [L, a, bVal];
}

function deltaE(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const [L1, a1, b1Lab] = rgbToLab(r1, g1, b1);
  const [L2, a2, b2Lab] = rgbToLab(r2, g2, b2);
  return Math.sqrt(
    Math.pow(L2 - L1, 2) +
    Math.pow(a2 - a1, 2) +
    Math.pow(b2Lab - b1Lab, 2)
  );
}

/**
 * Calculate structural similarity using a sliding window approach
 * More tolerant of slight position shifts from scaling
 */
function calculateStructuralDiff(
  buf1: Buffer,
  buf2: Buffer,
  width: number,
  height: number
): { diffPixels: number; diffBuffer: Buffer; ssimScore: number } {
  const totalPixels = width * height;
  let diffPixels = 0;
  const diffBuffer = Buffer.alloc(buf1.length);

  // For SSIM-like calculation
  let sumSquaredError = 0;
  let sumMeanDiff = 0;

  // Delta E threshold: 2.3 is "just noticeable difference" for humans
  // Using higher threshold for cross-platform tolerance
  const perceptualThreshold = THRESHOLD * 100;  // Scale threshold to Delta E range

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const r1 = buf1[offset];
    const g1 = buf1[offset + 1];
    const b1 = buf1[offset + 2];
    const r2 = buf2[offset];
    const g2 = buf2[offset + 1];
    const b2 = buf2[offset + 2];

    // Use perceptual color difference
    const de = deltaE(r1, g1, b1, r2, g2, b2);
    sumSquaredError += de * de;
    sumMeanDiff += de;

    if (de > perceptualThreshold) {
      diffPixels++;
      // Color-code by severity: yellow = minor, orange = moderate, red = major
      if (de > perceptualThreshold * 3) {
        diffBuffer[offset] = 255;      // Red
        diffBuffer[offset + 1] = 0;
        diffBuffer[offset + 2] = 0;
      } else if (de > perceptualThreshold * 2) {
        diffBuffer[offset] = 255;      // Orange
        diffBuffer[offset + 1] = 128;
        diffBuffer[offset + 2] = 0;
      } else {
        diffBuffer[offset] = 255;      // Yellow
        diffBuffer[offset + 1] = 255;
        diffBuffer[offset + 2] = 0;
      }
      diffBuffer[offset + 3] = 255;
    } else {
      // Show original pixel (grayscale blend)
      const gray = Math.round((r1 + g1 + b1 + r2 + g2 + b2) / 6);
      diffBuffer[offset] = gray;
      diffBuffer[offset + 1] = gray;
      diffBuffer[offset + 2] = gray;
      diffBuffer[offset + 3] = 255;
    }
  }

  // Calculate SSIM-like score (0-1, higher is more similar)
  const mse = sumSquaredError / totalPixels;
  const ssimScore = 1 / (1 + mse / 1000);  // Normalized similarity score

  return { diffPixels, diffBuffer, ssimScore };
}

/**
 * Calculate pixel difference between two RGBA buffers
 * Uses perceptual color difference (Delta E) for more accurate comparison
 */
function calculateDiff(
  buf1: Buffer,
  buf2: Buffer,
  width: number,
  height: number
): { diffPixels: number; diffBuffer: Buffer; ssimScore: number } {
  return calculateStructuralDiff(buf1, buf2, width, height);
}

/**
 * Compare screenshots for a single component
 */
async function compareComponent(componentName: string): Promise<ComparisonResult> {
  const contactSheetPath = join(DIFF_DIR, `${componentName}_all_platforms.png`);
  const result: ComparisonResult = {
    component: componentName,
    contactSheetPath,
    comparisons: [],
    missingPlatforms: [],
    invalidPlatforms: [],
  };

  const platforms = ["web", "canvas", "desktop", "ios", "android"] as const;
  const normalizedImages: { [key: string]: Buffer } = {};

  // Normalize all available screenshots
  for (const platform of platforms) {
    const imagePath = join(RESULTS_DIR, `${componentName}_${platform}.png`);
    if (existsSync(imagePath)) {
      try {
        normalizedImages[platform] = await normalizeScreenshot(
          imagePath,
          platform,
          PLATFORM_CONFIG,
          COMPARISON_CANVAS,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  Warning: Could not process ${platform} image: ${message}`);
        result.invalidPlatforms.push({ platform, error: message });
      }
    } else {
      result.missingPlatforms.push(platform);
    }
  }

  await createPlatformContactSheet(
    normalizedImages,
    TARGET_WIDTH,
    TARGET_HEIGHT,
    contactSheetPath,
    Object.fromEntries(
      CONTACT_SHEET_PLATFORMS.map(platform => {
        const geometry = normalizationGeometry(PLATFORM_CONFIG[platform]);
        return [platform, geometry.normalizedPixels];
      }),
    ),
  );

  // Compare all pairs
  const pairs: [string, string][] = [];
  for (let first = 0; first < platforms.length; first++) {
    for (let second = first + 1; second < platforms.length; second++) {
      pairs.push([platforms[first], platforms[second]]);
    }
  }

  for (const [p1, p2] of pairs) {
    if (!normalizedImages[p1] || !normalizedImages[p2]) {
      continue;
    }

    const { diffPixels, ssimScore } = calculateDiff(
      normalizedImages[p1],
      normalizedImages[p2],
      TARGET_WIDTH,
      TARGET_HEIGHT
    );

    const totalPixels = TARGET_WIDTH * TARGET_HEIGHT;
    const diffPercent = (diffPixels / totalPixels) * 100;

    result.comparisons.push({
      pair: `${p1} vs ${p2}`,
      diffPercent,
      diffPixels,
      totalPixels,
      ssimScore,
    });
  }

  return result;
}

/** Get the authoritative page list rather than inferring it from stale artifacts. */
function getComponents(): string[] {
  return registeredGalleryDeeplinks(join(SCRIPT_DIR, ".."));
}

/**
 * Main comparison function
 */
async function main(): Promise<void> {
  console.log("\n========================================");
  console.log("  Screenshot Comparison Tool");
  console.log("========================================\n");
  console.log(`Threshold: ${THRESHOLD} (${THRESHOLD * 100}% color difference)`);
  console.log(`Target size: ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
  console.log(`Output: ${DIFF_DIR}\n`);

  // Ensure diff directory exists
  if (!existsSync(DIFF_DIR)) {
    mkdirSync(DIFF_DIR, { recursive: true });
  }

  // Get components to compare
  let components = getComponents();
  if (specificComponent) {
    components = components.filter(c => c.toLowerCase() === specificComponent.toLowerCase());
    if (components.length === 0) {
      console.error(`Component "${specificComponent}" not found`);
      process.exit(1);
    }
  }

  // Pairwise diff sheets were the old output format. Remove only those exact
  // generated artifacts so the output directory cannot mix both designs.
  for (const component of components) {
    for (let first = 0; first < CONTACT_SHEET_PLATFORMS.length; first++) {
      for (let second = 0; second < CONTACT_SHEET_PLATFORMS.length; second++) {
        if (first === second) continue;
        const legacyPath = join(
          DIFF_DIR,
          `${component}_${CONTACT_SHEET_PLATFORMS[first]}_vs_${CONTACT_SHEET_PLATFORMS[second]}.png`,
        );
        if (existsSync(legacyPath)) unlinkSync(legacyPath);
      }
    }
  }

  console.log(`Comparing ${components.length} components...\n`);

  const results: ComparisonResult[] = [];

  for (const component of components) {
    process.stdout.write(`${component}: `);
    const result = await compareComponent(component);
    results.push(result);

    if (result.missingPlatforms.length > 0) {
      process.stdout.write(`(missing: ${result.missingPlatforms.join(", ")}) `);
    }
    if (result.invalidPlatforms.length > 0) {
      process.stdout.write(`(invalid: ${result.invalidPlatforms.map(item => item.platform).join(", ")}) `);
    }

    // Show comparison results
    // Similarity score: >95% = good (✓), 85-95% = acceptable (~), <85% = investigate (!)
    const diffs = result.comparisons.map(c => {
      const simPercent = (c.ssimScore * 100).toFixed(0);
      const status = c.ssimScore < 0.85 ? "!" : c.ssimScore < 0.95 ? "~" : "✓";
      return `${c.pair}: ${simPercent}%${status}`;
    });

    console.log(diffs.join(" | ") || "No comparisons possible");
  }

  // Summary
  console.log("\n========================================");
  console.log("  Summary");
  console.log("========================================\n");

  // Aggregate stats
  const allComparisons = results.flatMap(r => r.comparisons);
  const invalidScreenshots = results.flatMap(result =>
    result.invalidPlatforms.map(item => ({ component: result.component, ...item })),
  );
  const missingScreenshots = results.flatMap(result =>
    result.missingPlatforms.map(platform => ({ component: result.component, platform })),
  );
  const avgSimilarity = allComparisons.length > 0
    ? allComparisons.reduce((sum, c) => sum + c.ssimScore, 0) / allComparisons.length
    : 0;
  const minSimilarity = allComparisons.length > 0
    ? Math.min(...allComparisons.map(c => c.ssimScore))
    : 0;
  const lowSimilarity = allComparisons.filter(c => c.ssimScore < 0.85);

  console.log(`Total comparisons: ${allComparisons.length}`);
  console.log(`Average similarity: ${(avgSimilarity * 100).toFixed(1)}%`);
  console.log(`Minimum similarity: ${(minSimilarity * 100).toFixed(1)}%`);
  console.log(`Low similarity (<85%): ${lowSimilarity.length}`);
  console.log(`Missing screenshots: ${missingScreenshots.length}`);
  console.log(`Invalid screenshots: ${invalidScreenshots.length}`);

  if (missingScreenshots.length > 0) {
    console.log("\nMissing platform screenshots:");
    for (const item of missingScreenshots) {
      console.log(`  - ${item.component} (${item.platform})`);
    }
  }

  if (invalidScreenshots.length > 0) {
    console.log("\nScreenshots rejected by their device profile:");
    for (const item of invalidScreenshots) {
      console.log(`  - ${item.component} (${item.platform}): ${item.error}`);
    }
  }

  if (lowSimilarity.length > 0) {
    console.log("\nComponents needing attention:");
    for (const comp of lowSimilarity.sort((a, b) => a.ssimScore - b.ssimScore)) {
      const result = results.find(r => r.comparisons.includes(comp));
      console.log(`  - ${result?.component} (${comp.pair}): ${(comp.ssimScore * 100).toFixed(1)}% similarity`);
    }
  }

  console.log(`\nFive-platform comparison strips saved to: ${DIFF_DIR}`);

  // Write JSON report
  const reportPath = join(DIFF_DIR, "comparison-report.json");
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: {
      threshold: THRESHOLD,
      targetWidth: TARGET_WIDTH,
      targetHeight: TARGET_HEIGHT,
      platformConfig: PLATFORM_CONFIG,
    },
    summary: {
      totalComponents: components.length,
      totalComparisons: allComparisons.length,
      averageSimilarity: avgSimilarity,
      minimumSimilarity: minSimilarity,
      lowSimilarityCount: lowSimilarity.length,
      missingScreenshotCount: missingScreenshots.length,
      invalidScreenshotCount: invalidScreenshots.length,
    },
    results,
  }, null, 2));
  console.log(`Report saved to: ${reportPath}`);

  // Exit with error if any comparisons have very low similarity
  // Docs may intentionally publish known visual differences, but never accept
  // screenshots rejected by the pinned device profiles.
  if (
    missingScreenshots.length > 0
    || invalidScreenshots.length > 0
    || (!allowDifferences && lowSimilarity.length > 0)
  ) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
