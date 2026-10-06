import { readFileSync } from "fs";
import { join } from "path";

interface GalleryRegistryItem {
  deeplink: string;
}

function loadRegistry(path: string): GalleryRegistryItem[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(value) || value.some(item =>
    typeof item !== "object"
    || item === null
    || typeof (item as { deeplink?: unknown }).deeplink !== "string"
  )) {
    throw new Error(`Invalid gallery registry: ${path}`);
  }
  return value as GalleryRegistryItem[];
}

/** Return only pages registered by the component gallery itself. */
export function registeredGalleryDeeplinks(galleryRoot: string): string[] {
  const items = [
    ...loadRegistry(join(galleryRoot, "components.json")),
    ...loadRegistry(join(galleryRoot, "applicators.json")),
  ];
  return Array.from(new Set(items.map(item => item.deeplink))).sort();
}
