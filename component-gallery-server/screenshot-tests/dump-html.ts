#!/usr/bin/env bun
/**
 * Dump rendered HTML for a specific component
 *
 * Usage: bun run dump-html.ts <component-name>
 * Example: bun run dump-html.ts column
 */

import puppeteer from "puppeteer";

const WEB_GALLERY_PORT = 5556;

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: bun run dump-html.ts <component-name>");
    console.error("Example: bun run dump-html.ts column");
    process.exit(1);
  }

  const url = `http://localhost:${WEB_GALLERY_PORT}?name=${name}`;
  console.log(`Fetching: ${url}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 934, deviceScaleFactor: 1 });

  await page.goto(url, { waitUntil: "networkidle0", timeout: 8000 });

  // Wait for loading to complete
  await page.waitForFunction(
    () => {
      const loading = document.getElementById("loading");
      return loading?.classList.contains("hidden") || loading?.style.display === "none";
    },
    { timeout: 5000 }
  ).catch(() => {});

  await new Promise(r => setTimeout(r, 1500));

  // Get the rendered HTML
  const html = await page.evaluate(() => {
    const app = document.getElementById("app");
    return app ? app.outerHTML : document.body.innerHTML;
  });

  // Pretty print with indentation
  console.log("=== Rendered HTML ===\n");
  console.log(html);
  console.log("\n=== End HTML ===");

  // Also get computed styles for root element
  const styles = await page.evaluate(() => {
    const app = document.getElementById("app");
    if (!app || !app.firstElementChild) return null;
    const root = app.firstElementChild as HTMLElement;
    const computed = window.getComputedStyle(root);
    return {
      display: computed.display,
      flexDirection: computed.flexDirection,
      horizontalAlignment: computed.alignItems,
      verticalAlignment: computed.justifyContent,
      gap: computed.gap,
      width: computed.width,
      height: computed.height,
    };
  });

  if (styles) {
    console.log("\n=== Root Element Computed Styles ===");
    console.log(JSON.stringify(styles, null, 2));
  }

  await browser.close();
}

main().catch(console.error);
