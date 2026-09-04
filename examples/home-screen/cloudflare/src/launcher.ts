import { app } from "@hypen-space/core";
import { durableObjectStore, withKey } from "@hypen-space/cf";
import {
  CROP_KEYS,
  SWATCH_CROP,
  WALLPAPER_CROPS,
  WALLPAPER_PHOTOS,
  unsplashUrl,
  type CropKey,
  type UnsplashPhoto,
} from "./unsplash";
import { fetchWeather, getGeo } from "./geo";

// Hypen Home — a phone-style home screen that launches OTHER Hypen apps.
//
// Each app icon routes to a full-screen frame whose body is a single
// built-in `HypenApp("<ws-url>")` component — it connects to a remote Hypen
// app over WebSocket and renders its patches inline. Since every example in
// this repo deploys as a Cloudflare Worker, "installing an app" here is
// literally just a URL.
//
// The Settings icon opens a route of the launcher itself (no embed):
// wallpaper presets and an accent color, both plain state. The accent tints
// the app-frame chrome and the wallpaper is an applicator binding, so picking
// a swatch restyles the whole phone through ordinary reactive updates.
// Choices persist in the Durable Object.
//
// The photo wallpapers stream from Unsplash's Wallpapers topic (see
// unsplash.ts), and the binding is a responsive value map rather than a single
// value: `.background({default: …, sm: …, md: …, lg: …, xl: …})` lowers to one
// media-query rule per breakpoint, so each window downloads the rendition cut
// for its own size instead of every screen sharing one bitmap.
//
// The DSL template is generated from the APPS list with plain string
// interpolation — a nice reminder that Hypen templates are just strings.

export interface LauncherApp {
  /** Route segment: the app opens at /app/<slug>. */
  slug: string;
  /** Label under the icon. */
  name: string;
  /** SVG resource key used as the icon glyph. */
  resource: string;
  /** Glyph color. */
  iconColor: string;
  /** Layered CSS background for the icon tile. */
  tile: string;
  /** Translucent brand colour for the splash's breathing glow. */
  glow: string;
  /**
   * WebSocket endpoint of the deployed example.
   */
  url: string;
}

export const APPS: LauncherApp[] = [
  {
    slug: "todo",
    name: "Todo",
    resource: "check-square",
    iconColor: "#EFF6FF",
    tile: "radial-gradient(circle at 24% 14%, rgba(255,255,255,0.48), transparent 29%), linear-gradient(145deg, #38BDF8 0%, #4F46E5 52%, #312E81 100%)",
    glow: "rgba(79, 70, 229, 0.48)",
    url: "wss://hypen-todo.ian-dae.workers.dev/ws",
  },
  {
    slug: "calculator",
    name: "Calculator",
    resource: "calculator",
    iconColor: "#CFFAFE",
    tile: "radial-gradient(circle at 72% 12%, rgba(34,211,238,0.38), transparent 32%), linear-gradient(145deg, #334155 0%, #172554 54%, #020617 100%)",
    glow: "rgba(34, 211, 238, 0.30)",
    url: "wss://hypen-calculator.ian-dae.workers.dev/ws",
  },
  {
    slug: "calories",
    name: "Calories",
    resource: "activity",
    iconColor: "#FFF7ED",
    tile: "radial-gradient(circle at 28% 12%, rgba(255,255,255,0.42), transparent 28%), linear-gradient(145deg, #FB7185 0%, #F43F5E 45%, #BE123C 100%)",
    glow: "rgba(244, 63, 94, 0.48)",
    url: "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
  },
  {
    slug: "movies",
    name: "MovieDB",
    resource: "film",
    iconColor: "#FFFBEB",
    tile: "radial-gradient(circle at 28% 14%, rgba(255,255,255,0.46), transparent 27%), linear-gradient(145deg, #FDE047 0%, #F59E0B 46%, #C2410C 100%)",
    glow: "rgba(245, 158, 11, 0.46)",
    url: "wss://hypen-movie-discovery.ian-dae.workers.dev/ws",
  },
  {
    slug: "food",
    name: "Food",
    resource: "utensils",
    iconColor: "#ECFDF5",
    tile: "radial-gradient(circle at 27% 13%, rgba(255,255,255,0.44), transparent 28%), linear-gradient(145deg, #6EE7B7 0%, #10B981 45%, #047857 100%)",
    glow: "rgba(16, 185, 129, 0.44)",
    url: "wss://hypen-food-ordering.ian-dae.workers.dev/ws",
  },
  {
    slug: "social",
    name: "Social",
    resource: "message-circle",
    iconColor: "#F5F3FF",
    tile: "radial-gradient(circle at 26% 13%, rgba(255,255,255,0.46), transparent 29%), linear-gradient(145deg, #818CF8 0%, #7C3AED 48%, #581C87 100%)",
    glow: "rgba(124, 58, 237, 0.46)",
    url: "wss://hypen-social.ian-dae.workers.dev/ws",
  },
  {
    slug: "hypeflix",
    name: "Hypeflix",
    resource: "play-circle",
    iconColor: "#FFF1F2",
    tile: "radial-gradient(circle at 28% 14%, rgba(255,255,255,0.44), transparent 28%), linear-gradient(145deg, #FB7185 0%, #E11D48 48%, #881337 100%)",
    glow: "rgba(225, 29, 72, 0.48)",
    url: "wss://hypen-hypeflix.ian-dae.workers.dev/ws",
  },
];

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  "activity": iconSvg(
    stroke("M13.7 2.5c.35 2.8-1.15 4.35-2.65 5.9-1.55 1.6-3.05 3.15-3.05 5.7A4.35 4.35 0 0 0 12.35 18.5c2.6 0 4.65-1.95 4.65-4.65 0-1.8-.85-3.75-2.55-5.85.05 2.25-.8 3.55-2.2 4.65") +
      stroke("M12.1 21.5c-4 0-7.1-2.85-7.1-6.75") +
      stroke("M12 16c-1.2-.75-1.65-1.9-1.25-3.35"),
  ),
  "battery": iconSvg(
    stroke("M17 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2") +
      stroke("M22 13v-2") +
      stroke("M5.5 10.5v3") +
      stroke("M8.5 10.5v3") +
      stroke("M11.5 10.5v3"),
  ),
  "chevron-left": iconSvg(stroke("M15 18l-6-6 6-6")),
  "signal": iconSvg(stroke("M4 19v-2") + stroke("M9 19v-5") + stroke("M14 19v-9") + stroke("M19 19V6")),
  "wifi": iconSvg(stroke("M5 12.55a11 11 0 0 1 14.08 0") + stroke("M8.53 16.11a6 6 0 0 1 6.95 0") + stroke("M12 20h.01")),
  "sun": iconSvg(
    stroke("M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8") +
      stroke("M12 2v2") + stroke("M12 20v2") +
      stroke("M4.93 4.93l1.41 1.41") + stroke("M17.66 17.66l1.41 1.41") +
      stroke("M2 12h2") + stroke("M20 12h2") +
      stroke("M4.93 19.07l1.41-1.41") + stroke("M17.66 6.34l1.41-1.41"),
  ),
  "cloud": iconSvg(stroke("M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10")),
  "cloud-sun": iconSvg(
    stroke("M12 2v2") + stroke("M4.93 4.93l1.41 1.41") + stroke("M20 12h2") + stroke("M19.07 4.93l-1.41 1.41") +
      stroke("M15.95 12.65a4 4 0 0 0-5.93-4.13") +
      stroke("M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6"),
  ),
  "rain": iconSvg(
    stroke("M17.5 16a4.5 4.5 0 0 0 0-9h-.34A6.5 6.5 0 1 0 6 16h11.5") +
      stroke("M8 19v2") + stroke("M12 19v2") + stroke("M16 19v2"),
  ),
  "snow": iconSvg(
    stroke("M17.5 16a4.5 4.5 0 0 0 0-9h-.34A6.5 6.5 0 1 0 6 16h11.5") +
      stroke("M8 20h.01") + stroke("M12 21h.01") + stroke("M16 20h.01"),
  ),
  "calculator": iconSvg(
    stroke("M8.5 3h7A5.5 5.5 0 0 1 21 8.5v7a5.5 5.5 0 0 1-5.5 5.5h-7A5.5 5.5 0 0 1 3 15.5v-7A5.5 5.5 0 0 1 8.5 3Z") +
      stroke("M7.5 6.5v4M5.5 8.5h4") +
      stroke("M14.5 8.5h4") +
      stroke("M5.8 15.8l3-3M8.8 15.8l-3-3") +
      stroke("M14.5 13.5h4M14.5 16.5h4"),
  ),
  "check-square": iconSvg(
    stroke("M9 3h6a6 6 0 0 1 6 6v6a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6Z") +
      `<path d="m7.5 12 3 3 6.5-7" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/>` +
      stroke("M18.5 5.5h.01"),
  ),
  "chevron-right": iconSvg(stroke("M9 18l6-6-6-6")),
  "film": iconSvg(
    stroke("M8 6h8a5 5 0 0 1 5 5v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5v-5a5 5 0 0 1 5-5Z") +
      stroke("M10 10v7l6-3.5-6-3.5Z") +
      `<path d="M5 3h14M7 3l2 3m3-3 2 3m3-3 2 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  "play-circle": iconSvg(
    stroke("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18") +
      stroke("M10 8.25v7.5l6-3.75-6-3.75Z") +
      stroke("M5 5l1.25 1.25M18 17.75 19.25 19"),
  ),
  "image": iconSvg(stroke("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5") + stroke("M8 11l3 3 2-2 5 5") + stroke("M8.5 8.5h.01")),
  "message-circle": iconSvg(
    `<path d="M6 6a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-4.5L7 16v-3.35A3 3 0 0 1 6 10V6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>` +
      `<path d="M10 8h.01M13 8h.01M16 8h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>` +
      `<path d="M11 18h4l3.5 2.5V17a3 3 0 0 0 2-2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  "palette": iconSvg(stroke("M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a1.5 1.5 0 0 1 0-3h1a8 8 0 0 0 8-8.2C21 4.7 17 3 12 3") + stroke("M7.5 10.5h.01") + stroke("M10 7.5h.01") + stroke("M14 7.5h.01") + stroke("M16.5 10.5h.01")),
  "settings": iconSvg(
    stroke("M4 7h3M11 7h9M4 12h10M18 12h2M4 17h2M10 17h10") +
      stroke("M9 5v4M16 10v4M8 15v4"),
  ),
  "utensils": iconSvg(
    `<path d="M4 10h16a8 8 0 0 1-16 0Zm3 10h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M8 7c0-1.6 1.2-1.9 1.2-3.5M12 7c0-1.6 1.2-1.9 1.2-3.5M16 7c0-1.6 1.2-1.9 1.2-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  ),
};

// The Settings "app" lives on the grid like any other icon but routes into
// the launcher's own /settings screen instead of embedding a remote app.
const SETTINGS_ICON = {
  slug: "settings",
  name: "Settings",
  resource: "settings",
  iconColor: "#F8FAFC",
  tile: "radial-gradient(circle at 27% 13%, rgba(255,255,255,0.46), transparent 29%), linear-gradient(145deg, #CBD5E1 0%, #64748B 48%, #334155 100%)",
  route: "/settings",
};

interface Wallpaper {
  id: string;
  name: string;
  /** Row subtitle: the photographer for a photo, the kind for a gradient. */
  credit: string;
  /**
   * One full CSS `background` value per breakpoint, keyed like an applicator
   * value map. Photos vary per tier (different Unsplash rendition); gradients
   * repeat the same string, which costs nothing and keeps the shape uniform.
   */
  css: Record<CropKey, string>;
  /** Thumbnail-sized background for the 36px swatch in Settings. */
  swatch: string;
  selected: boolean;
}

interface Accent {
  id: string;
  color: string;
  selected: boolean;
}

/**
 * Scrim painted over every photo wallpaper.
 *
 * The home screen puts white status text, a white clock and white icon labels
 * directly on the wallpaper, and a topic photo can be bright anywhere. Two
 * stops — a light wash at the top for the status bar, a heavier one at the
 * bottom for the dock — keep all of that legible without muddying the photo.
 */
const SCRIM = "linear-gradient(180deg, rgba(3, 7, 18, 0.25), rgba(3, 7, 18, 0.62))";

/**
 * Base colour behind the photo. In the `background` shorthand the colour
 * belongs to the last layer, so it paints instantly while the Unsplash
 * rendition is still in flight — no white flash on a cold load.
 */
const PHOTO_BASE = "#0B1020";

/**
 * Escape a value for a double-quoted string in the generated DSL.
 *
 * Preset names and photographer credits are copied out of Unsplash, so they
 * are not ours to trust as template fragments: a quote or a backslash in a
 * credit would otherwise end the DSL string early.
 */
function dslString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

/** The per-breakpoint `background` values for one Unsplash photo. */
function photoCss(photo: UnsplashPhoto): Record<CropKey, string> {
  const css = {} as Record<CropKey, string>;
  for (const key of CROP_KEYS) {
    const url = unsplashUrl(photo, WALLPAPER_CROPS[key]);
    css[key] = `${SCRIM}, url('${url}') center / cover no-repeat ${PHOTO_BASE}`;
  }
  return css;
}

/** A gradient preset needs no renditions — the same value at every tier. */
function flatCss(value: string): Record<CropKey, string> {
  const css = {} as Record<CropKey, string>;
  for (const key of CROP_KEYS) css[key] = value;
  return css;
}

function photoWallpaper(photo: UnsplashPhoto): Wallpaper {
  return {
    id: photo.id,
    name: photo.name,
    credit: `Photo · ${photo.credit}`,
    css: photoCss(photo),
    swatch: `url('${unsplashUrl(photo, SWATCH_CROP)}') center / cover no-repeat ${PHOTO_BASE}`,
    selected: false,
  };
}

function gradientWallpaper(id: string, name: string, value: string): Wallpaper {
  return { id, name, credit: "Gradient", css: flatCss(value), swatch: value, selected: false };
}

// Bumped for the new persisted shape (photo ids replaced the "torres" preset).
const HOME_STATE_KEY = "home-screen:v5";

const WALLPAPERS: Wallpaper[] = [
  ...WALLPAPER_PHOTOS.map(photoWallpaper),
  gradientWallpaper("indigo", "Indigo Night", "linear-gradient(180deg, #312e81, #0f172a)"),
  gradientWallpaper("sunset", "Sunset", "linear-gradient(180deg, #7c2d12, #831843)"),
  gradientWallpaper("emerald", "Deep Emerald", "linear-gradient(180deg, #064e3b, #022c22)"),
  gradientWallpaper("graphite", "Graphite", "linear-gradient(180deg, #334155, #0f172a)"),
  gradientWallpaper("hypen", "Hypen Pink", "linear-gradient(180deg, #831843, #1e1b4b)"),
].map((wallpaper, index) => ({ ...wallpaper, selected: index === 0 }));

/**
 * The wallpaper applicator, shared by the home and settings routes.
 *
 * This is the media-query half of the story. A value map on an applicator
 * lowers to one CSS rule per breakpoint (`@media (min-width: 768px) { … }` for
 * `md`, and so on), so the browser — not the server, and not a resize
 * listener — decides which Unsplash rendition to download. Only the matching
 * rule's `url()` is ever fetched.
 *
 * Every tier is a binding, so switching preset in Settings restyles all five
 * rules through the ordinary reactive path. Keep the keys in ascending order:
 * breakpoint rules share specificity, so the later rule in the sheet wins.
 */
const WALLPAPER_BACKGROUND =
  '.background({' +
  'default: "@{state.wallpaper}", ' +
  'sm: "@{state.wallpaperSm}", ' +
  'md: "@{state.wallpaperMd}", ' +
  'lg: "@{state.wallpaperLg}", ' +
  'xl: "@{state.wallpaperXl}"' +
  '})';

/** Copy a preset's five renditions onto the state fields the DSL binds. */
function applyWallpaper(state: LauncherState, wallpaper: Wallpaper): void {
  state.wallpaperId = wallpaper.id;
  state.wallpaper = wallpaper.css.default;
  state.wallpaperSm = wallpaper.css.sm;
  state.wallpaperMd = wallpaper.css.md;
  state.wallpaperLg = wallpaper.css.lg;
  state.wallpaperXl = wallpaper.css.xl;
}

const ACCENTS: Accent[] = [
  { id: "blue", color: "#93C5FD", selected: true },
  { id: "pink", color: "#FFA7E1", selected: false },
  { id: "amber", color: "#FCD34D", selected: false },
  { id: "mint", color: "#6EE7B7", selected: false },
];

export interface LauncherState {
  location: string;
  /** Selected wallpaper preset id. */
  wallpaperId: string;
  /**
   * Current wallpaper CSS, one field per breakpoint. `WALLPAPER_BACKGROUND`
   * binds all five into a single `.background({default: …, sm: …, …})`, which
   * the renderer lowers to one media-query rule each — so a desktop window
   * downloads the desktop-sized Unsplash rendition and a phone downloads the
   * phone-sized one. Flat fields rather than a nested object: dependency
   * tracking is path-based, and replacing a parent object wholesale is a
   * clumsier way to signal five changed leaves.
   */
  wallpaper: string;
  wallpaperSm: string;
  wallpaperMd: string;
  wallpaperLg: string;
  wallpaperXl: string;
  /** Selected accent preset id. */
  accentId: string;
  /** Current accent color — tints back buttons, titles, and checkmarks. */
  accent: string;
  wallpapers: Wallpaper[];
  accents: Accent[];
  /** Live clock (viewer's timezone via request.cf) — widget + status bar. */
  timeLabel: string;
  dateLabel: string;
  /** Weather for the connection's geo (request.cf → Open-Meteo). */
  weatherReady: boolean;
  weatherIcon: string;
  weatherTemp: string;
  weatherDesc: string;
  weatherHiLo: string;
  weatherCity: string;
}

/** "9:41"-style time + long date in the viewer's timezone. */
function clockLabels(timezone: string): { time: string; date: string } {
  const now = new Date();
  const opts = { hour: "numeric", minute: "2-digit", hour12: true } as const;
  const dateOpts = { weekday: "long", month: "long", day: "numeric" } as const;
  try {
    return {
      time: now.toLocaleTimeString("en-US", { ...opts, timeZone: timezone }).replace(/\s?(AM|PM)$/i, ""),
      date: now.toLocaleDateString("en-US", { ...dateOpts, timeZone: timezone }),
    };
  } catch {
    // Bad/unknown IANA name from the edge — fall back to UTC.
    return {
      time: now.toLocaleTimeString("en-US", opts).replace(/\s?(AM|PM)$/i, ""),
      date: now.toLocaleDateString("en-US", dateOpts),
    };
  }
}

function applyClock(state: LauncherState): void {
  const { time, date } = clockLabels(getGeo().timezone);
  if (state.timeLabel !== time) state.timeLabel = time;
  if (state.dateLabel !== date) state.dateLabel = date;
}

/** One ticker per module instance; cleared on destroy. */
const clockTimers = new WeakMap<object, ReturnType<typeof setInterval>>();

/**
 * One tappable icon (tile + label) for the home grid or the dock.
 *
 * `sharedKey` pairs this tile with the matching one in the app's splash
 * slot, so opening the app flies the icon from the grid into the splash
 * and scales it up. Only the grid passes a key: the dock repeats the same
 * four apps, and two sources sharing one key is ambiguous (the renderer
 * takes the first and warns), so dock taps get the plain route fade.
 */
function appIcon(
  a: { name: string; resource: string; iconColor: string; tile: string },
  to: string,
  { label = true, sharedKey = "" } = {},
): string {
  return `
          Button {
            Column {
              Column {
                Icon(@resources.${a.resource})
                  .size({default: 36, md: 40})
                  .color("${a.iconColor}")
              }
              .tw("w-[60px] h-[60px] rounded-[19px] items-center justify-center border border-white/20 shadow-xl")
              .background("${a.tile}")
              .width({default: 60, md: 66})
              .height({default: 60, md: 66})${
                sharedKey
                  ? `
              .sharedElement("${sharedKey}", curve: spring, duration: 340)`
                  : ""
              }
              ${
                label
                  ? `Text("${a.name}")
                .tw("text-[11px] mt-1.5 font-semibold tracking-[-0.01em]")
                .color("#F3F4F6")`
                  : ""
              }
            }
            .tw("items-center")
          }
          .onClick(@router.push, to: "${to}")
          .opacity({ default: 1, active: 0.65 })
          .transition(140, easeOut)
          .tw("bg-transparent border-0 p-0 w-[60px]")`;
}

/** Full-screen frame for one app: slim dark chrome + embedded HypenApp. */
function appRoute(a: LauncherApp): string {
  return `
        Route(path: "/app/${a.slug}") {
          // Top/side insets keep the frame chrome clear of the notch;
          // the bottom edge is left to the embedded app, which brings
          // its own SafeArea if it wants one.
          SafeArea(edges: ["top", "left", "right"]) {
            Row {
              // iOS-style "back to Home" capsule — the accent from Settings
              // tints the chevron; the label stays neutral.
              Button {
                Row {
                  Icon(@resources.chevron-left)
                    .size(15)
                    .color("@{state.accent}")
                  Text("Home")
                    .tw("text-xs font-medium ml-0.5")
                    .color("#E5E7EB")
                }
                .tw("items-center")
              }
              .onClick(@router.push, to: "/")
              .opacity({ default: 1, active: 0.6 })
              .transition(140, easeOut)
              .backgroundColor("rgba(255, 255, 255, 0.08)")
              .tw("border border-white/10 rounded-full pl-1.5 pr-3 py-1 shrink-0")

              // Quiet app label — the app below carries its own branding, so
              // the chrome just whispers where you are.
              Text("${a.name}")
                .tw("text-xs font-medium flex-1 text-center")
                .color("#6B7280")

              // Spacer to balance the back capsule so the label centers.
              Column {}
                .tw("w-[74px] shrink-0")
            }
            .tw("items-center px-3 py-2 bg-gray-950 shrink-0")
            .enter(fade, duration: 320)

            Column {
              HypenApp("${a.url}") {
                Column {
                  // Soft bloom in the app's brand colour so the splash isn't
                  // a flat black sheet — it breathes behind the icon while
                  // the connection comes up.
                  Box {}
                    .background("radial-gradient(85% 60% at 50% 38%, ${a.glow} 0%, rgba(3, 7, 18, 0) 70%)")
                    .tw("absolute inset-0")
                    .enter(fade, duration: 600)
                    .animate(pulse, duration: 2600)

                  Column {
                    Icon(@resources.${a.resource})
                      .size(46)
                      .color("${a.iconColor}")
                  }
                  .tw("w-[76px] h-[76px] rounded-[22px] items-center justify-center border border-white/20 shadow-2xl")
                  .background("${a.tile}")
                  .sharedElement("app-${a.slug}", curve: spring, duration: 340)

                  Text("${a.name}")
                    .tw("mt-6 text-[15px] font-semibold")
                    .color("#F9FAFB")
                    .enter(fade, duration: 260)

                  Text("Connecting…")
                    .tw("mt-1.5 text-xs")
                    .color("#6B7280")
                    .enter(fade, duration: 320)
                    .animate(pulse, duration: 1600)
                }
                .slot("loading")
                .tw("relative flex-1 w-full h-full min-h-0 items-center justify-center bg-gray-950")

                Column {
                  Column {
                    Icon(@resources.${a.resource})
                      .size(24)
                      .color("#6B7280")
                  }
                  .tw("w-14 h-14 rounded-2xl bg-white/5 border border-white/10 items-center justify-center")

                  Text("Couldn't open ${a.name}")
                    .tw("mt-5 text-[15px] font-semibold")
                    .color("#F9FAFB")

                  Text("Check the worker connection and try again.")
                    .tw("mt-1.5 text-xs text-center")
                    .color("#6B7280")
                }
                .slot("error")
                .tw("flex-1 w-full h-full min-h-0 items-center justify-center bg-gray-950 px-8")
              }
              .tw("flex-1 w-full min-h-0")
            }
            .tw("flex-1 w-full min-h-0 bg-white overflow-hidden")
          }
          .tw("flex-1 min-h-screen w-full overflow-hidden bg-gray-950")
        }`;
}

/** The launcher's own Settings screen — wallpaper + accent pickers. */
function settingsRoute(): string {
  const wallpaperRows = WALLPAPERS.map(
    (wallpaper) => `
                Button {
                  Row {
                    Box {}
                      .background("${wallpaper.swatch}")
                      .tw("w-9 h-9 rounded-lg border border-white/20")

                    Column {
                      Text("${dslString(wallpaper.name)}")
                        .tw("text-[15px] font-medium text-left")
                        .color("#F9FAFB")
                      Text("${dslString(wallpaper.credit)}")
                        .tw("text-xs mt-0.5 text-left")
                        .color("#9CA3AF")
                    }
                    .tw("ml-3 flex-1 items-start")

                    Row {
                      Text("@{state.wallpaperId == '${wallpaper.id}' ? '✓' : ''}")
                        .tw("text-[15px] font-semibold mr-2")
                        .color("@{state.accent}")
                      Icon(@resources.chevron-right)
                        .size(18)
                        .color("#6B7280")
                    }
                    .tw("items-center")
                  }
                  .tw("items-center w-full")
                }
                .onClick(@actions.setWallpaper, id: "${wallpaper.id}")
                .tw("bg-transparent border-0 p-3 w-full")`,
  ).join("\n");
  const accentRows = ACCENTS.map(
    (accent) => `
                Button {
                  Row {
                    Box {}
                      .background("${accent.color}")
                      .tw("w-9 h-9 rounded-lg border border-white/20")

                    Column {
                      Text("${accent.id[0]!.toUpperCase()}${accent.id.slice(1)}")
                        .tw("text-[15px] font-medium text-left")
                        .color("#F9FAFB")
                      Text("@{state.accentId == '${accent.id}' ? 'Selected' : 'Accent color'}")
                        .tw("text-xs mt-0.5 text-left")
                        .color("#9CA3AF")
                    }
                    .tw("ml-3 flex-1 items-start")

                    Row {
                      Text("@{state.accentId == '${accent.id}' ? '✓' : ''}")
                        .tw("text-[15px] font-semibold mr-2")
                        .color("@{state.accent}")
                      Icon(@resources.chevron-right)
                        .size(18)
                        .color("#6B7280")
                    }
                    .tw("items-center")
                  }
                  .tw("items-center w-full")
                }
                .onClick(@actions.setAccent, id: "${accent.id}")
                .tw("bg-transparent border-0 p-3 w-full")`,
  ).join("\n");

  return `
        Route(path: "/settings") {
          // Wallpaper on the wrapper, not the SafeArea -- see the home route.
          // overflow-auto stays on the SafeArea so the list scrolls inside the
          // safe region while the wallpaper behind it holds still.
          Column {
            SafeArea {
              Column {
                Row {
                  Button {
                    Row {
                      Icon(@resources.chevron-left)
                        .size(20)
                        .color("@{state.accent}")
                      Text("Home")
                        .tw("text-[17px] font-medium")
                        .color("@{state.accent}")
                    }
                    .tw("items-center")
                  }
                  .onClick(@router.push, to: "/")
                  .opacity({ default: 1, active: 0.6 })
                  .transition(140, easeOut)
                  .tw("bg-transparent border-0 px-0 py-2")

                  Column {}
                    .tw("flex-1")
                }
                .tw("items-center w-full")

                Text("Settings")
                  .tw("text-[34px] font-bold mt-1")
                  .color("#F9FAFB")
              }
              .tw("px-5 pt-3 pb-2 w-full items-start")

              Column {
                Column {
                  Row {
                    Column {
                      Icon(@resources.image)
                        .size(20)
                        .color("#ffffff")
                    }
                    .tw("w-8 h-8 rounded-lg bg-sky-500 items-center justify-center")
                    Text("Wallpaper")
                      .tw("text-[15px] font-medium ml-3 flex-1")
                      .color("#F9FAFB")
                  }
                  .tw("items-center px-3 pt-3 pb-1")
  ${wallpaperRows}
                }
                .tw("w-full rounded-2xl bg-black/30 border border-white/10 overflow-hidden")
                .backdropFilter("blur(20px)")

                Column {
                  Row {
                    Column {
                      Icon(@resources.palette)
                        .size(20)
                        .color("#ffffff")
                    }
                    .tw("w-8 h-8 rounded-lg bg-pink-500 items-center justify-center")
                    Text("Appearance")
                      .tw("text-[15px] font-medium ml-3 flex-1")
                      .color("#F9FAFB")
                  }
                  .tw("items-center px-3 pt-3 pb-1")
  ${accentRows}
                }
                .tw("w-full rounded-2xl bg-black/30 border border-white/10 overflow-hidden mt-5")
                .backdropFilter("blur(20px)")

                Column {
                  Row {
                    Column {
                      Icon(@resources.settings)
                        .size(20)
                        .color("#ffffff")
                    }
                    .tw("w-8 h-8 rounded-lg bg-gray-500 items-center justify-center")
                    Column {
                      Text("Hypen Home")
                        .tw("text-[15px] font-medium")
                        .color("#F9FAFB")
                      Text("Cloudflare Worker")
                        .tw("text-xs mt-0.5")
                        .color("#9CA3AF")
                    }
                    .tw("ml-3 flex-1 items-start")
                  }
                  .tw("items-center p-3")
                }
                .tw("w-full rounded-2xl bg-black/30 border border-white/10 overflow-hidden mt-5")
                .backdropFilter("blur(20px)")
              }
              .tw("px-5 pt-2 w-full")
            }
            .tw("flex-1 w-full items-center overflow-auto pb-8")
          }
          ${WALLPAPER_BACKGROUND}
          .tw("flex-1 min-h-screen w-full items-center")
        }`;
}

/** The full home-screen DSL, generated from APPS. Exported for tooling. */
export function buildLauncherTemplate(apps: LauncherApp[] = APPS): string {
  // The icon grid is rows of four, iOS-style. (The engine's Grid component
  // is data-driven — it wants an array binding — so a static launcher grid
  // is plain Rows.) Partial rows are padded with invisible spacers so the
  // remaining icons stay left-aligned on the same columns.
  const gridItems: Array<{ item: { name: string; resource: string; iconColor: string; tile: string }; to: string }> = [
    ...apps.map((a) => ({ item: a, to: `/app/${a.slug}` })),
    { item: SETTINGS_ICON, to: SETTINGS_ICON.route },
  ];
  const gridRows: (typeof gridItems)[] = [];
  for (let i = 0; i < gridItems.length; i += 4) {
    gridRows.push(gridItems.slice(i, i + 4));
  }
  const homeGrid = gridRows
    .map((row) => {
      const cells = row.map(({ item, to }) =>
        appIcon(item, to, {
          // Only the embedded apps have a splash slot to fly into; Settings
          // routes into the launcher itself, so it gets no key (an unmatched
          // key degrades to a plain navigation and warns in dev).
          sharedKey: to.startsWith("/app/") ? `app-${to.slice("/app/".length)}` : "",
        }),
      );
      for (let i = row.length; i < 4; i++) {
        cells.push(`
          Column {}
            .tw("w-[60px]")`);
      }
      return `
            Row {
${cells.join("\n")}
            }
            .tw("items-start justify-between w-full")`;
    })
    .join("\n");
  const dock = apps
    .slice(0, 4)
    .map((a) => appIcon(a, `/app/${a.slug}`, { label: false }))
    .join("\n");
  const appRoutes = apps.map(appRoute).join("\n");

  return `
  module App {
    Column {
      Router {
        Route(path: "/") {
          // The wallpaper is painted by a wrapper OUTSIDE the SafeArea, not by
          // the SafeArea itself. Both look full-bleed today (SafeArea applies its
          // insets as padding, and a background covers the padding band), but
          // painting outside keeps the wallpaper independent of how SafeArea
          // models its insets -- and of whether it generates a box at all: a
          // SafeArea rendered as display:contents paints no background whatsoever.
          // The wrapper runs edge to edge under the notch / status bar / home
          // indicator; the SafeArea inside keeps the status row, widget, grid and
          // dock within the safe region.
          Column {
            SafeArea {
              // ----- Status bar -----
              Row {
                Text("@{state.timeLabel}")
                  .tw("text-[13px] font-semibold tracking-wide")
                  .color("#F9FAFB")
                Row {
                  Icon(@resources.signal)
                    .size(14)
                    .color("#F9FAFB")
                  Icon(@resources.wifi)
                    .size(15)
                    .color("#F9FAFB")
                  Icon(@resources.battery)
                    .size(20)
                    .color("#F9FAFB")
                }
                .tw("items-center gap-1.5")
              }
              .tw("items-center justify-between px-7 pt-3.5 pb-5 w-full")

              // ----- Clock + weather widget -----
              Button {
                Row {
                  Column {
                    Text("@{state.timeLabel}")
                      .tw("text-[44px] font-light leading-none tracking-tight text-left")
                      .color("#FFFFFF")
                    Text("@{state.dateLabel}")
                      .tw("text-[13px] font-medium mt-2 text-left")
                      .color("#D1D5DB")
                  }
                  .tw("flex-1 items-start")

                  If(condition: "@{state.weatherReady}") {
                    Column {
                      Row {
                        If(condition: "@{state.weatherIcon == 'sun'}") {
                          Icon(@resources.sun)
                            .size(20)
                            .color("#FDE68A")
                        }
                        If(condition: "@{state.weatherIcon == 'cloud-sun'}") {
                          Icon(@resources.cloud-sun)
                            .size(20)
                            .color("#FDE68A")
                        }
                        If(condition: "@{state.weatherIcon == 'cloud'}") {
                          Icon(@resources.cloud)
                            .size(20)
                            .color("#E5E7EB")
                        }
                        If(condition: "@{state.weatherIcon == 'rain'}") {
                          Icon(@resources.rain)
                            .size(20)
                            .color("#BFDBFE")
                        }
                        If(condition: "@{state.weatherIcon == 'snow'}") {
                          Icon(@resources.snow)
                            .size(20)
                            .color("#E0F2FE")
                        }
                        Text("@{state.weatherTemp}")
                          .tw("text-[22px] font-semibold ml-1.5")
                          .color("#FFFFFF")
                      }
                      .tw("items-center")

                      Text("@{state.weatherDesc}")
                        .tw("text-xs font-medium mt-1 text-right")
                        .color("#D1D5DB")
                      Text("@{state.weatherCity}")
                        .tw("text-[11px] mt-0.5 text-right")
                        .color("#9CA3AF")
                      Text("@{state.weatherHiLo}")
                        .tw("text-[11px] mt-0.5 text-right")
                        .color("#9CA3AF")
                    }
                    .tw("items-end shrink-0")
                    .enter(fade, duration: 320)
                  }
                }
                .tw("items-center w-full")
              }
              .tw("w-full max-w-[330px] md:max-w-[350px] rounded-[26px] bg-black/25 border border-white/10 p-5 mt-1")
              .alignSelf("center")
              .backdropFilter("blur(20px)")
              .opacity({ default: 1, active: 0.8 })
              .transition(150, easeOut)
              .onClick(@router.push, to: "/settings")
              .enter(fade, duration: 300)

              // ----- App grid -----
              Column {
  ${homeGrid}
              }
              .tw("gap-5 mt-7 w-full max-w-[330px] md:max-w-[350px]")

              Column {}
                .tw("flex-1")

              // ----- Dock -----
              Column {
                Row {
  ${dock}
                }
                .tw("items-center justify-between bg-white/10 border border-white/10 rounded-[30px] px-4 py-3.5 w-full shadow-2xl")
                .backdropFilter("blur(20px)")
              }
              .tw("mb-4 w-full max-w-[330px] md:max-w-[350px]")
            }
            .tw("flex-1 w-full items-center")
          }
          ${WALLPAPER_BACKGROUND}
          .tw("flex-1 min-h-screen w-full items-center")
        }
${settingsRoute()}
${appRoutes}
      }
      .tw("flex-1 w-full")
    }
    .tw("flex-1 w-full min-h-screen bg-gray-950 items-center")
  }
`;
}

// `location` is the Router's default binding; the generic client mirrors the
// browser URL into it, so deep links and the back button work. Wallpaper and
// accent persist in the Durable Object — the phone remembers its look.
function initialLauncherState(): LauncherState {
  return {
    location: "/",
    wallpaperId: WALLPAPERS[0]!.id,
    wallpaper: WALLPAPERS[0]!.css.default,
    wallpaperSm: WALLPAPERS[0]!.css.sm,
    wallpaperMd: WALLPAPERS[0]!.css.md,
    wallpaperLg: WALLPAPERS[0]!.css.lg,
    wallpaperXl: WALLPAPERS[0]!.css.xl,
    accentId: "blue",
    accent: ACCENTS[0]!.color,
    wallpapers: WALLPAPERS,
    accents: ACCENTS,
    timeLabel: clockLabels(getGeo().timezone).time,
    dateLabel: clockLabels(getGeo().timezone).date,
    weatherReady: false,
    weatherIcon: "cloud-sun",
    weatherTemp: "",
    weatherDesc: "",
    weatherHiLo: "",
    weatherCity: "",
  };
}

// Persist only the user's choices, not the whole state. Ids are enough: the
// preset tables rebuild every rendition on load, so a refreshed `WALLPAPER_PHOTOS`
// reaches returning visitors instead of being pinned by whatever was saved.
// (It also keeps the saved value tiny — this used to hold a ~0.5MB base64
// wallpaper, which blew the DO per-value limit until it was trimmed out.)
// The clock/weather fields are per-connection anyway.
interface PersistedChoices {
  location: string;
  wallpaperId: string;
  accentId: string;
}

const baseStore = durableObjectStore<LauncherState>(withKey<LauncherState>(() => HOME_STATE_KEY));

const launcherStore: typeof baseStore = {
  __bindStorage: (storage) => baseStore.__bindStorage(storage),
  resolveKey: (state, moduleName, sessionId) => baseStore.resolveKey(state, moduleName, sessionId),
  async load(key) {
    const saved = (await baseStore.load(key)) as PersistedChoices | LauncherState | null;
    if (!saved || typeof saved.wallpaperId !== "string") return null;
    const wallpaper = WALLPAPERS.find((w) => w.id === saved.wallpaperId) ?? WALLPAPERS[0]!;
    const accent = ACCENTS.find((a) => a.id === saved.accentId) ?? ACCENTS[0]!;
    return {
      ...initialLauncherState(),
      location: typeof saved.location === "string" ? saved.location : "/",
      wallpaperId: wallpaper.id,
      wallpaper: wallpaper.css.default,
      wallpaperSm: wallpaper.css.sm,
      wallpaperMd: wallpaper.css.md,
      wallpaperLg: wallpaper.css.lg,
      wallpaperXl: wallpaper.css.xl,
      wallpapers: WALLPAPERS.map((w) => ({ ...w, selected: w.id === wallpaper.id })),
      accentId: accent.id,
      accent: accent.color,
      accents: ACCENTS.map((a) => ({ ...a, selected: a.id === accent.id })),
    };
  },
  async save(key, state) {
    const choices: PersistedChoices = {
      location: state.location,
      wallpaperId: state.wallpaperId,
      accentId: state.accentId,
    };
    await baseStore.save(key, choices as unknown as LauncherState);
  },
  delete: (key) => baseStore.delete(key),
};

export default app
  .defineState<LauncherState>(initialLauncherState())
  .persist(launcherStore)
  .onCreated(async (state) => {
    // Geo was parked by the DO's fetch before any handler runs, so the first
    // render already shows the viewer's local time; the ticker keeps the
    // minutes honest for as long as the session lives.
    applyClock(state);
    const timer = setInterval(() => applyClock(state), 30_000);
    clockTimers.set(state as object, timer);

    const geo = getGeo();
    const weather = await fetchWeather(geo);
    if (weather) {
      state.weatherIcon = weather.icon;
      state.weatherTemp = weather.temp;
      state.weatherDesc = weather.description;
      state.weatherHiLo = weather.hiLo;
      state.weatherCity = geo.city;
      state.weatherReady = true;
    }
  })
  .onActivated((state) => {
    applyClock(state);
  })
  .onDestroyed((state) => {
    const timer = clockTimers.get(state as object);
    if (timer !== undefined) clearInterval(timer);
  })
  .onAction<{ id: string }>("setWallpaper", ({ action, state }) => {
    const id = action.payload?.id;
    const wp = state.wallpapers.find((w) => w.id === id);
    if (!wp) return;
    applyWallpaper(state, wp);
    state.wallpapers = state.wallpapers.map((w) => ({ ...w, selected: w.id === id }));
  })
  .onAction<{ id: string }>("setAccent", ({ action, state }) => {
    const id = action.payload?.id;
    const accent = state.accents.find((a) => a.id === id);
    if (!accent) return;
    state.accentId = accent.id;
    state.accent = accent.color;
    state.accents = state.accents.map((a) => ({ ...a, selected: a.id === id }));
  })
  .ui(buildLauncherTemplate());
