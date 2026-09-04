#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

interface RegistryItem {
  name: string;
  deeplink: string;
}

interface ComparisonSection {
  title: string;
  items: Array<RegistryItem & { image: string }>;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(SCRIPT_DIR, "..");
const GALLERY_ROOT = join(DOCS_ROOT, "..", "component-gallery-server");
const SOURCE_DIR = join(GALLERY_ROOT, "screenshot-tests", "results", "diffs");
const DEST_DIR = join(DOCS_ROOT, "public", "comparison");
const MANIFEST_PATH = join(DOCS_ROOT, "lib", "comparison-manifest.json");

function readRegistry(filename: string): RegistryItem[] {
  const path = join(GALLERY_ROOT, filename);
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(value) || value.some(item =>
    typeof item !== "object"
    || item === null
    || typeof (item as Partial<RegistryItem>).name !== "string"
    || typeof (item as Partial<RegistryItem>).deeplink !== "string"
  )) {
    throw new Error(`Invalid gallery registry: ${path}`);
  }
  return value as RegistryItem[];
}

function copySection(title: string, registry: RegistryItem[]): ComparisonSection {
  return {
    title,
    items: registry.map(item => {
      const filename = `${item.deeplink}_all_platforms.png`;
      const source = join(SOURCE_DIR, filename);
      if (!existsSync(source)) {
        throw new Error(
          `Missing five-platform screenshot: ${source}\n` +
          "Run the screenshot capture and comparison before updating docs.",
        );
      }
      copyFileSync(source, join(DEST_DIR, filename));
      return { ...item, image: `/comparison/${filename}` };
    }),
  };
}

function copyScreenshots() {
  console.log("Copying five-platform comparison screenshots to docs...");

  if (!existsSync(SOURCE_DIR)) {
    throw new Error(
      `Comparison output not found: ${SOURCE_DIR}\n` +
      "Run the screenshot capture and comparison before updating docs.",
    );
  }

  if (existsSync(DEST_DIR)) rmSync(DEST_DIR, { recursive: true });
  mkdirSync(DEST_DIR, { recursive: true });

  const sections = [
    copySection("Components", readRegistry("components.json")),
    copySection("Applicators", readRegistry("applicators.json")),
  ];

  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ sections }, null, 2)}\n`);

  const screenshotCount = sections.reduce((count, section) => count + section.items.length, 0);
  console.log(`Copied ${screenshotCount} five-platform screenshots and regenerated the docs manifest.`);
}

copyScreenshots();
