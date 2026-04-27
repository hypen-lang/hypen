#!/usr/bin/env bun
/**
 * Take a screenshot using Puppeteer
 * Usage: bun take-screenshot.ts <url> <output_path> [width] [height]
 */

const url = process.argv[2];
const outputPath = process.argv[3];
const width = parseInt(process.argv[4] || "430");
const height = parseInt(process.argv[5] || "934");

if (!url || !outputPath) {
  console.error("Usage: bun take-screenshot.ts <url> <output_path> [width] [height]");
  process.exit(1);
}

const puppeteer = await import("puppeteer");

const browser = await puppeteer.default.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
});

try {
  const page = await browser.newPage();

  await page.setViewport({
    width,
    height,
    deviceScaleFactor: 1,
  });

  // Navigate and wait for network to be idle
  await page.goto(url, { waitUntil: "networkidle0", timeout: 10000 });

  // Wait for loading spinner to disappear
  await page.waitForFunction(
    () => {
      const loading = document.getElementById("loading");
      return loading?.classList.contains("hidden") || loading?.style.display === "none";
    },
    { timeout: 5000 }
  ).catch(() => {
    // Continue if loading never hides (might be static content)
  });

  // Wait for WebSocket data and CSS transitions
  await new Promise(r => setTimeout(r, 1500));

  // Take screenshot
  await page.screenshot({ path: outputPath, fullPage: false });

  console.log(`Screenshot saved to: ${outputPath}`);
} finally {
  await browser.close();
}
