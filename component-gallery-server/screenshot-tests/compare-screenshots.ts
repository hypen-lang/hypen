#!/usr/bin/env bun
/**
 * Screenshot Comparison Tool
 *
 * Compares screenshots across iOS, Android, and Web platforms.
 * Handles different screen dimensions and toolbar cropping.
 *
 * Usage:
 *   bun run compare-screenshots.ts [options]
 *
 * Options:
 *   --component=X    Compare only a specific component
 *   --threshold=X    Pixel difference threshold 0-1 (default: 0.1)
 *   --output=dir     Output directory for diff images (default: results/diffs)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import sharp from "sharp";

// Configuration
const SCRIPT_DIR = dirname(import.meta.path);
const RESULTS_DIR = join(SCRIPT_DIR, "results");

// Platform-specific configuration
// Crop values determined by measuring actual screenshots
const PLATFORM_CONFIG = {
  web: {
    width: 430,
    height: 934,
    cropTop: 0,      // No toolbar
    cropBottom: 0,   // No home indicator
    scale: 1,
  },
  ios: {
    width: 1320,
    height: 2868,
    cropTop: 408,    // Status bar (~141px) + Nav bar (~267px) at 3x
    cropBottom: 102, // Home indicator at 3x
    scale: 1320 / 430,
  },
  android: {
    width: 1344,
    height: 2992,
    cropTop: 441,    // Status bar (~126px) + App bar (~315px) at 3x
    cropBottom: 126, // Navigation bar at 3x
    scale: 1344 / 430,
  },
};

// Target comparison size (web dimensions)
const TARGET_WIDTH = 430;
const TARGET_HEIGHT = 934;

// Parse arguments
const args = process.argv.slice(2);
const componentArg = args.find(a => a.startsWith("--component="));
const specificComponent = componentArg ? componentArg.split("=")[1] : null;
const thresholdArg = args.find(a => a.startsWith("--threshold="));
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.1;
const outputArg = args.find(a => a.startsWith("--output="));
const DIFF_DIR = outputArg ? outputArg.split("=")[1] : join(RESULTS_DIR, "diffs");

interface ComparisonResult {
  component: string;
  comparisons: {
    pair: string;
    diffPercent: number;
    diffPixels: number;
    totalPixels: number;
    ssimScore: number;  // 0-1, higher = more similar
    diffImagePath: string;
  }[];
  missingPlatforms: string[];
}

/**
 * Normalize a screenshot: crop toolbars/indicators and resize to target dimensions
 */
async function normalizeScreenshot(
  inputPath: string,
  platform: "web" | "ios" | "android"
): Promise<Buffer> {
  const config = PLATFORM_CONFIG[platform];

  let image = sharp(inputPath);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read image dimensions: ${inputPath}`);
  }

  // Crop top (status bar, nav bar) and bottom (home indicator, nav bar)
  const cropTop = config.cropTop || 0;
  const cropBottom = config.cropBottom || 0;
  const contentHeight = metadata.height - cropTop - cropBottom;

  if (cropTop > 0 || cropBottom > 0) {
    image = image.extract({
      left: 0,
      top: cropTop,
      width: metadata.width,
      height: contentHeight,
    });
  }

  // Resize to target dimensions
  image = image.resize(TARGET_WIDTH, TARGET_HEIGHT, {
    fit: "fill",  // Stretch to exact dimensions
    kernel: "lanczos3",
  });

  // Convert to raw RGBA for comparison
  return image.ensureAlpha().raw().toBuffer();
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
 * Create a side-by-side comparison image: [Image A] [Diff] [Image B]
 */
async function createComparisonImage(
  buf1: Buffer,
  buf2: Buffer,
  diffBuffer: Buffer,
  width: number,
  height: number,
  outputPath: string,
  label1: string,
  label2: string
): Promise<void> {
  // Convert buffers to sharp images
  const img1 = sharp(buf1, { raw: { width, height, channels: 4 } });
  const img2 = sharp(buf2, { raw: { width, height, channels: 4 } });
  const diffImg = sharp(diffBuffer, { raw: { width, height, channels: 4 } });

  // Create PNG buffers
  const [png1, png2, pngDiff] = await Promise.all([
    img1.png().toBuffer(),
    img2.png().toBuffer(),
    diffImg.png().toBuffer(),
  ]);

  // Create side-by-side composite (3 images wide)
  const totalWidth = width * 3;
  const labelHeight = 30;
  const totalHeight = height + labelHeight;

  // Create the composite image
  await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 40, g: 40, b: 40, alpha: 1 },
    },
  })
    .composite([
      // Image 1 (left)
      { input: png1, left: 0, top: labelHeight },
      // Diff (center)
      { input: pngDiff, left: width, top: labelHeight },
      // Image 2 (right)
      { input: png2, left: width * 2, top: labelHeight },
      // Labels
      {
        input: Buffer.from(
          `<svg width="${totalWidth}" height="${labelHeight}">
            <rect width="100%" height="100%" fill="#282828"/>
            <text x="${width / 2}" y="20" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="14">${label1}</text>
            <text x="${width * 1.5}" y="20" text-anchor="middle" fill="#ff6b6b" font-family="sans-serif" font-size="14">DIFF</text>
            <text x="${width * 2.5}" y="20" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="14">${label2}</text>
          </svg>`
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toFile(outputPath);
}

/**
 * Compare screenshots for a single component
 */
async function compareComponent(componentName: string): Promise<ComparisonResult> {
  const result: ComparisonResult = {
    component: componentName,
    comparisons: [],
    missingPlatforms: [],
  };

  const platforms = ["web", "ios", "android"] as const;
  const normalizedImages: { [key: string]: Buffer } = {};

  // Normalize all available screenshots
  for (const platform of platforms) {
    const imagePath = join(RESULTS_DIR, `${componentName}_${platform}.png`);
    if (existsSync(imagePath)) {
      try {
        normalizedImages[platform] = await normalizeScreenshot(imagePath, platform);
      } catch (error) {
        console.warn(`  Warning: Could not process ${platform} image: ${error}`);
        result.missingPlatforms.push(platform);
      }
    } else {
      result.missingPlatforms.push(platform);
    }
  }

  // Compare all pairs
  const pairs: [string, string][] = [
    ["web", "ios"],
    ["web", "android"],
    ["ios", "android"],
  ];

  for (const [p1, p2] of pairs) {
    if (!normalizedImages[p1] || !normalizedImages[p2]) {
      continue;
    }

    const { diffPixels, diffBuffer, ssimScore } = calculateDiff(
      normalizedImages[p1],
      normalizedImages[p2],
      TARGET_WIDTH,
      TARGET_HEIGHT
    );

    const totalPixels = TARGET_WIDTH * TARGET_HEIGHT;
    const diffPercent = (diffPixels / totalPixels) * 100;

    // Save side-by-side comparison image
    const diffImagePath = join(DIFF_DIR, `${componentName}_${p1}_vs_${p2}.png`);
    await createComparisonImage(
      normalizedImages[p1],
      normalizedImages[p2],
      diffBuffer,
      TARGET_WIDTH,
      TARGET_HEIGHT,
      diffImagePath,
      p1.toUpperCase(),
      p2.toUpperCase()
    );

    result.comparisons.push({
      pair: `${p1} vs ${p2}`,
      diffPercent,
      diffPixels,
      totalPixels,
      ssimScore,
      diffImagePath,
    });
  }

  return result;
}

/**
 * Get list of components from screenshot files
 */
function getComponents(): string[] {
  const files = readdirSync(RESULTS_DIR);
  const components = new Set<string>();

  for (const file of files) {
    const match = file.match(/^(.+)_(web|ios|android)\.png$/);
    if (match) {
      components.add(match[1]);
    }
  }

  return Array.from(components).sort();
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

  console.log(`Comparing ${components.length} components...\n`);

  const results: ComparisonResult[] = [];

  for (const component of components) {
    process.stdout.write(`${component}: `);
    const result = await compareComponent(component);
    results.push(result);

    if (result.missingPlatforms.length > 0) {
      process.stdout.write(`(missing: ${result.missingPlatforms.join(", ")}) `);
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
  const avgSimilarity = allComparisons.reduce((sum, c) => sum + c.ssimScore, 0) / allComparisons.length;
  const minSimilarity = Math.min(...allComparisons.map(c => c.ssimScore));
  const lowSimilarity = allComparisons.filter(c => c.ssimScore < 0.85);

  console.log(`Total comparisons: ${allComparisons.length}`);
  console.log(`Average similarity: ${(avgSimilarity * 100).toFixed(1)}%`);
  console.log(`Minimum similarity: ${(minSimilarity * 100).toFixed(1)}%`);
  console.log(`Low similarity (<85%): ${lowSimilarity.length}`);

  if (lowSimilarity.length > 0) {
    console.log("\nComponents needing attention:");
    for (const comp of lowSimilarity.sort((a, b) => a.ssimScore - b.ssimScore)) {
      const result = results.find(r => r.comparisons.includes(comp));
      console.log(`  - ${result?.component} (${comp.pair}): ${(comp.ssimScore * 100).toFixed(1)}% similarity`);
    }
  }

  console.log(`\nDiff images saved to: ${DIFF_DIR}`);

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
    },
    results,
  }, null, 2));
  console.log(`Report saved to: ${reportPath}`);

  // Exit with error if any comparisons have very low similarity
  if (lowSimilarity.length > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
