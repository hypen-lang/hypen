import { app } from "@hypen-space/core";
import { durableObjectStore, withKey } from "@hypen-space/cf";
import homeWallpaper from "./assets/home-wallpaper";
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
// wallpaper presets and an accent color, both plain state. The wallpaper is
// an applicator binding — `.background("@{state.wallpaper}")` — and the
// accent tints the app-frame chrome, so picking a swatch restyles the whole
// phone through ordinary reactive updates. Choices persist in the Durable
// Object.
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
  /** Tailwind classes for the icon tile background. */
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
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-indigo-400 to-violet-600",
    glow: "rgba(124, 58, 237, 0.45)",
    url: "wss://hypen-todo.ian-dae.workers.dev/ws",
  },
  {
    slug: "calculator",
    name: "Calculator",
    resource: "calculator",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-slate-500 to-slate-800",
    glow: "rgba(100, 116, 139, 0.40)",
    url: "wss://hypen-calculator.ian-dae.workers.dev/ws",
  },
  {
    slug: "calories",
    name: "Calories",
    resource: "activity",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-pink-400 to-rose-600",
    glow: "rgba(225, 29, 72, 0.45)",
    url: "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
  },
  {
    slug: "movies",
    name: "Movies",
    resource: "film",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-amber-400 to-orange-600",
    glow: "rgba(234, 88, 12, 0.45)",
    url: "wss://hypen-movie-discovery.ian-dae.workers.dev/ws",
  },
  {
    slug: "food",
    name: "Food",
    resource: "utensils",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-emerald-400 to-green-600",
    glow: "rgba(22, 163, 74, 0.45)",
    url: "wss://hypen-food-ordering.ian-dae.workers.dev/ws",
  },
  {
    slug: "social",
    name: "Social",
    resource: "message-circle",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-fuchsia-400 to-purple-600",
    glow: "rgba(147, 51, 234, 0.45)",
    url: "wss://hypen-social.ian-dae.workers.dev/ws",
  },
];

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  "activity": iconSvg(stroke("M22 12h-4l-3 9L9 3l-3 9H2")),
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
    stroke("M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2") +
      stroke("M8 6h8") +
      stroke("M8 10h.01") +
      stroke("M12 10h.01") +
      stroke("M16 10h.01") +
      stroke("M8 14h.01") +
      stroke("M12 14h.01") +
      stroke("M16 14h.01") +
      stroke("M8 18h.01") +
      stroke("M12 18h.01") +
      stroke("M16 18h.01"),
  ),
  "check-square": iconSvg(stroke("M9 11l3 3L22 4") + stroke("M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11")),
  "chevron-right": iconSvg(stroke("M9 18l6-6-6-6")),
  "film": iconSvg(
    stroke("M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2") +
      stroke("M8 3v18") +
      stroke("M16 3v18") +
      stroke("M2 9h20") +
      stroke("M2 15h20"),
  ),
  "image": iconSvg(stroke("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5") + stroke("M8 11l3 3 2-2 5 5") + stroke("M8.5 8.5h.01")),
  "message-circle": iconSvg(stroke("M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5")),
  "palette": iconSvg(stroke("M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a1.5 1.5 0 0 1 0-3h1a8 8 0 0 0 8-8.2C21 4.7 17 3 12 3") + stroke("M7.5 10.5h.01") + stroke("M10 7.5h.01") + stroke("M14 7.5h.01") + stroke("M16.5 10.5h.01")),
  "settings": iconSvg(stroke("M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5") + stroke("M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.6 20a1.65 1.65 0 0 0-1.82-.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 8.6a1.65 1.65 0 0 0 .6 1 1.65 1.65 0 0 0 1.82.33H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.82.33 1.65 1.65 0 0 0-.69.74")),
  "utensils": iconSvg(stroke("M4 3v8") + stroke("M8 3v8") + stroke("M4 7h4") + stroke("M6 11v10") + stroke("M16 3c2 1.5 3 4 3 7s-1 5.5-3 7V3") + stroke("M16 17v4")),
};

// The Settings "app" lives on the grid like any other icon but routes into
// the launcher's own /settings screen instead of embedding a remote app.
const SETTINGS_ICON = {
  slug: "settings",
  name: "Settings",
  resource: "settings",
  iconColor: "#ffffff",
  tile: "bg-gradient-to-br from-gray-400 to-gray-600",
  route: "/settings",
};

interface Wallpaper {
  id: string;
  name: string;
  /** CSS background value — bound straight into `.background(...)`. */
  css: string;
  selected: boolean;
}

interface Accent {
  id: string;
  color: string;
  selected: boolean;
}

const PHOTO_WALLPAPER = `linear-gradient(180deg, rgba(3, 7, 18, 0.08), rgba(3, 7, 18, 0.6)), url('${homeWallpaper}') center / cover no-repeat`;
const HOME_STATE_KEY = "home-screen:v4";

const WALLPAPERS: Wallpaper[] = [
  { id: "torres", name: "Torres Night", css: PHOTO_WALLPAPER, selected: true },
  { id: "indigo", name: "Indigo Night", css: "linear-gradient(180deg, #312e81, #0f172a)", selected: false },
  { id: "sunset", name: "Sunset", css: "linear-gradient(180deg, #7c2d12, #831843)", selected: false },
  { id: "emerald", name: "Deep Emerald", css: "linear-gradient(180deg, #064e3b, #022c22)", selected: false },
  { id: "graphite", name: "Graphite", css: "linear-gradient(180deg, #334155, #0f172a)", selected: false },
  { id: "hypen", name: "Hypen Pink", css: "linear-gradient(180deg, #831843, #1e1b4b)", selected: false },
];

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
  /** Current wallpaper CSS — bound by `.background(...)` on every screen. */
  wallpaper: string;
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
                  .size({default: 29, md: 32})
                  .color("${a.iconColor}")
              }
              .tw("w-[60px] h-[60px] rounded-[19px] ${a.tile} items-center justify-center shadow-lg")
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
                .tw("text-[11px] mt-1.5 font-medium")
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
          Column {
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
                      .size(32)
                      .color("${a.iconColor}")
                  }
                  .tw("w-[76px] h-[76px] rounded-[22px] ${a.tile} items-center justify-center shadow-2xl")
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
                      .background("${wallpaper.css}")
                      .tw("w-9 h-9 rounded-lg border border-white/20")

                    Column {
                      Text("${wallpaper.name}")
                        .tw("text-[15px] font-medium text-left")
                        .color("#F9FAFB")
                      Text("@{state.wallpaperId == '${wallpaper.id}' ? 'Selected' : 'Wallpaper'}")
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
          Column {
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
          .background("@{state.wallpaper}")
          .tw("flex-1 min-h-screen w-full items-center overflow-auto pb-8")
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
          Column {
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
          .background("@{state.wallpaper}")
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
    wallpaperId: "torres",
    wallpaper: PHOTO_WALLPAPER,
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

// Persist only the user's choices, not the whole state: the photo wallpaper
// is a ~0.5MB data URI baked into `wallpaper`/`wallpapers`, which blows the
// DO storage per-value limit (SQLITE_TOOBIG) if saved wholesale. Ids are
// enough — css/accent rehydrate from the preset tables on load, and the
// clock/weather fields are per-connection anyway.
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
      wallpaper: wallpaper.css,
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
    state.wallpaperId = wp.id;
    state.wallpaper = wp.css;
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
