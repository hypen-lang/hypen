/**
 * Wallpapers, served live from Unsplash's "Wallpapers" topic.
 *
 * The home screen used to ship a single 533x800 JPEG inlined as a ~116 KB
 * base64 data URI. That is fine on a phone and visibly mushy on a desktop
 * monitor, and there is no way to ask a data URI for a bigger version.
 *
 * So the wallpaper is now an ordinary Unsplash image URL. `images.unsplash.com`
 * is an imgix endpoint: the crop, the pixel size, the quality and the encoding
 * are all query parameters, so ONE photo id yields as many renditions as we
 * want. We use that to hand each Hypen breakpoint its own rendition — see
 * `WALLPAPER_CROPS` below — instead of stretching one fixed bitmap across
 * every screen.
 *
 * Nothing here needs an API key: the photo ids below are hotlinked straight
 * from the topic, which is what Unsplash asks embedders to do. To refresh the
 * set, pick new photos from https://unsplash.com/t/wallpapers and swap their
 * ids into `WALLPAPER_PHOTOS` — the settings rows are generated from that
 * table, so the picker follows automatically.
 */

/** A rendition request: pixel box plus JPEG/WebP quality. */
export interface Crop {
  w: number;
  h: number;
  q: number;
}

/**
 * One crop per Hypen breakpoint, keyed exactly like an applicator value map
 * (`{default: …, sm: …, md: …}`), which is how launcher.ts feeds these to
 * `.background(...)`. Breakpoints are min-width, so `default` is the phone
 * case and each step up is a wider window.
 *
 * Two things change as the window grows, not just one:
 *
 * - **Pixels.** `default` is sized for a retina phone (1080x1920 device px on
 *   a ~390 CSS px viewport); `xl` is sized for a 1440p desktop. The old
 *   533x800 bitmap was roughly the `default` row — hence "ok on mobile, bad on
 *   desktop".
 * - **Aspect.** A 9:16 portrait crop scaled with `cover` into a 16:9 window
 *   throws away most of the frame. Each tier asks Unsplash for a crop shaped
 *   like the viewport it is for, so the composition survives the resize too.
 *
 * There is no `2xl` row: the DSL's value-map keys are parsed as identifiers,
 * and `2xl` does not start with a letter, so it cannot be written as a map
 * key. `xl` is sized generously to cover everything from 1280 px up.
 */
export const WALLPAPER_CROPS = {
  default: { w: 1080, h: 1920, q: 70 }, // < 640  — phones, 9:16      (~145 KB AVIF)
  sm: { w: 1280, h: 1600, q: 70 }, //      >= 640  — large phones, 4:5
  md: { w: 1600, h: 1200, q: 72 }, //      >= 768  — tablets, 4:3
  lg: { w: 2048, h: 1280, q: 72 }, //      >= 1024 — laptops, 16:10
  xl: { w: 2560, h: 1440, q: 72 }, //      >= 1280 — desktops, 16:9    (~400 KB AVIF)
} as const satisfies Record<string, Crop>;

export type CropKey = keyof typeof WALLPAPER_CROPS;

/** Crop keys in ascending min-width order — the order the CSS rules must be emitted in. */
export const CROP_KEYS = ["default", "sm", "md", "lg", "xl"] as const;

/** The 36px swatch in Settings needs a thumbnail, not a wallpaper. */
export const SWATCH_CROP: Crop = { w: 96, h: 96, q: 60 };

export interface UnsplashPhoto {
  /** Preset id — also the key persisted in the Durable Object. */
  id: string;
  /** Label for the settings row. */
  name: string;
  /** Photographer, shown under the label (Unsplash asks for attribution). */
  credit: string;
  /** Permalink to the photo on Unsplash. */
  link: string;
  /** Base image URL; imgix parameters are appended per crop. */
  raw: string;
}

/**
 * Photos from https://unsplash.com/t/wallpapers.
 *
 * Deliberately dark or midtone frames: the home screen paints white status
 * text, a white clock and white icon labels straight onto the wallpaper.
 * All are at least 2700 px wide, so even the `xl` rendition is a downscale
 * rather than an upscale — check that before adding one, since imgix will
 * happily enlarge a small original and hand back a soft crop.
 */
export const WALLPAPER_PHOTOS: UnsplashPhoto[] = [
  {
    id: "prism-curve",
    name: "Prism Curve",
    credit: "Noam Cohen",
    link: "https://unsplash.com/photos/a-close-up-of-a-white-and-blue-object-EJhtDSR-ghc",
    raw: "https://images.unsplash.com/photo-1716643406202-f3a5f212f827",
  },
  {
    id: "night-ridge",
    name: "Night Ridge",
    credit: "Batuhan Doğan",
    link: "https://unsplash.com/photos/snow-capped-mountain-peaks-under-stars-PTs6_rET9Sg",
    raw: "https://images.unsplash.com/photo-1786698853071-2a5cc0d81f75",
  },
  {
    id: "blue-currents",
    name: "Blue Currents",
    credit: "Oxana Golubets",
    link: "https://unsplash.com/photos/wavy-blue-lines-against-a-dark-background-MNsXlmQ3r1g",
    raw: "https://images.unsplash.com/photo-1752606402432-9eeb131c6101",
  },
  {
    id: "crater-lake",
    name: "Crater Lake",
    credit: "Rowan Heuvel",
    link: "https://unsplash.com/photos/turquoise-volcanic-crater-lake-CpVwilODVaI",
    raw: "https://images.unsplash.com/photo-1786288042250-1258f5839eaf",
  },
];

/**
 * Build the imgix URL for one rendition of a photo.
 *
 * `auto=format` is the other half of the win: browsers that accept AVIF/WebP
 * get one, so the 2560px desktop rendition lands around 400 KB rather than the
 * ~1 MB the equivalent JPEG would cost.
 *
 * `crop=entropy` picks the busiest region when the requested aspect differs
 * from the original's, which keeps the subject in frame across the tiers.
 */
export function unsplashUrl(photo: UnsplashPhoto, crop: Crop): string {
  const url = new URL(photo.raw);
  url.searchParams.set("auto", "format");
  url.searchParams.set("fit", "crop");
  url.searchParams.set("crop", "entropy");
  url.searchParams.set("w", String(crop.w));
  url.searchParams.set("h", String(crop.h));
  url.searchParams.set("q", String(crop.q));
  return url.toString();
}
