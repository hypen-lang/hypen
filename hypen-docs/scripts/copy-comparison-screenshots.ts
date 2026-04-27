#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(SCRIPT_DIR, "..");
const SOURCE_DIR = join(DOCS_ROOT, "..", "component-gallery-server", "screenshot-tests", "results");
const DEST_DIR = join(DOCS_ROOT, "public", "comparison");

function copyScreenshots() {
  console.log("📸 Copying comparison screenshots...");
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Dest:   ${DEST_DIR}`);

  // Check source exists
  if (!existsSync(SOURCE_DIR)) {
    console.error(`❌ Source directory not found: ${SOURCE_DIR}`);
    console.error("   Run the screenshot tests first: cd component-gallery-server/screenshot-tests && ./run-tests.sh");
    process.exit(1);
  }

  // Clean and create destination directory
  if (existsSync(DEST_DIR)) {
    rmSync(DEST_DIR, { recursive: true });
  }
  mkdirSync(DEST_DIR, { recursive: true });

  // Copy all PNG files
  const files = readdirSync(SOURCE_DIR).filter(f => f.endsWith(".png"));

  if (files.length === 0) {
    console.error("❌ No screenshot files found in source directory");
    console.error("   Run the screenshot tests first: cd component-gallery-server/screenshot-tests && ./run-tests.sh");
    process.exit(1);
  }

  let copied = 0;
  for (const file of files) {
    const src = join(SOURCE_DIR, file);
    const dest = join(DEST_DIR, file);
    copyFileSync(src, dest);
    copied++;
  }

  console.log(`✅ Copied ${copied} screenshots to docs`);
}

copyScreenshots();
