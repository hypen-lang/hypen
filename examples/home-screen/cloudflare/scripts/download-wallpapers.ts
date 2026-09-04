import { mkdir } from "node:fs/promises";
import {
  CROP_KEYS,
  SWATCH_CROP,
  WALLPAPER_ASSET_VERSION,
  WALLPAPER_CROPS,
  WALLPAPER_PHOTOS,
  unsplashUrl,
} from "../src/unsplash";

const outputDirectory = new URL(`../public/wallpapers/${WALLPAPER_ASSET_VERSION}/`, import.meta.url);
await mkdir(outputDirectory, { recursive: true });

async function download(name: string, url: string): Promise<void> {
  const response = await fetch(url, {
    headers: { Accept: "image/avif" },
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${response.statusText}`);

  const contentType = response.headers.get("content-type");
  if (contentType !== "image/avif") {
    throw new Error(`${name}: expected image/avif, received ${contentType ?? "no content type"}`);
  }

  const bytes = await response.arrayBuffer();
  await Bun.write(new URL(name, outputDirectory), bytes);
  console.log(`${name} ${(bytes.byteLength / 1024).toFixed(1)} KB`);
}

for (const photo of WALLPAPER_PHOTOS) {
  for (const key of CROP_KEYS) {
    await download(`${photo.id}-${key}.avif`, unsplashUrl(photo, WALLPAPER_CROPS[key]));
  }
  await download(`${photo.id}-swatch.avif`, unsplashUrl(photo, SWATCH_CROP));
}
