import { app } from "@hypen-space/core";
import { durableObjectStore, withKey } from "@hypen-space/cf";
import homeWallpaper from "./assets/home-wallpaper";

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
    url: "wss://hypen-todo.ian-dae.workers.dev/ws",
  },
  {
    slug: "calculator",
    name: "Calculator",
    resource: "calculator",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-slate-500 to-slate-800",
    url: "wss://hypen-calculator.ian-dae.workers.dev/ws",
  },
  {
    slug: "calories",
    name: "Calories",
    resource: "activity",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-pink-400 to-rose-600",
    url: "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
  },
  {
    slug: "movies",
    name: "Movies",
    resource: "film",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-amber-400 to-orange-600",
    url: "wss://hypen-movie-discovery.ian-dae.workers.dev/ws",
  },
  {
    slug: "food",
    name: "Food",
    resource: "utensils",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-emerald-400 to-green-600",
    url: "wss://hypen-food-ordering.ian-dae.workers.dev/ws",
  },
  {
    slug: "social",
    name: "Social",
    resource: "message-circle",
    iconColor: "#ffffff",
    tile: "bg-gradient-to-br from-fuchsia-400 to-purple-600",
    url: "wss://hypen-social.ian-dae.workers.dev/ws",
  },
];

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  "activity": iconSvg(stroke("M22 12h-4l-3 9L9 3l-3 9H2")),
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
const HOME_STATE_KEY = "home-screen:v3";

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
}

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
                  .size(28)
                  .color("${a.iconColor}")
              }
              .tw("w-14 h-14 rounded-2xl ${a.tile} items-center justify-center shadow-lg")${
                sharedKey
                  ? `
              .sharedElement("${sharedKey}", curve: spring, duration: 340)`
                  : ""
              }
              ${
                label
                  ? `Text("${a.name}")
                .tw("text-xs mt-1.5 font-medium")
                .color("#E5E7EB")`
                  : ""
              }
            }
            .tw("items-center")
          }
          .onClick(@router.push, to: "${to}")
          .opacity({ default: 1, active: 0.65 })
          .transition(140, easeOut)
          .tw("bg-transparent border-0 p-0")`;
}

/** Full-screen frame for one app: top bar + embedded HypenApp. */
function appRoute(a: LauncherApp): string {
  return `
        Route(path: "/app/${a.slug}") {
          Column {
            Row {
              Button {
                Text("‹ Home")
                  .tw("text-sm font-semibold")
                  .color("@{state.accent}")
              }
              .onClick(@router.push, to: "/")
              .tw("bg-transparent border-0 px-2 py-1")

              Row {
                Icon(@resources.${a.resource})
                  .size(18)
                  .color("${a.iconColor}")
                Text("${a.name}")
                  .tw("text-sm font-semibold ml-2")
                  .color("#F9FAFB")
              }
              .tw("items-center")

              // Spacer to balance the back button so the title centers.
              Column {}
                .tw("w-16")
            }
            .tw("items-center justify-between px-3 py-3 ${a.tile}")
            .enter(fade, duration: 420)

            Column {
              HypenApp("${a.url}") {
                Column {
                  Column {}
                    .tw("absolute inset-0 ${a.tile}")
                    .enter(fade, duration: 420)

                  Column {
                    Icon(@resources.${a.resource})
                      .size(34)
                      .color("${a.iconColor}")
                  }
                  .tw("w-20 h-20 rounded-[24px] ${a.tile} items-center justify-center shadow-xl")
                  .sharedElement("app-${a.slug}", curve: spring, duration: 340)

                  Text("${a.name}")
                    .tw("mt-5 text-lg font-semibold")
                    .color("#F9FAFB")
                    .enter(fade, duration: 260)

                  Text("Opening app...")
                    .tw("mt-1 text-xs")
                    .color("#9CA3AF")
                    .enter(fade, duration: 320)
                    .animate(pulse, duration: 1600)
                }
                .slot("loading")
                .tw("relative flex-1 w-full h-full min-h-0 items-center justify-center bg-gray-950")

                Column {
                  Text("Couldn't open ${a.name}")
                    .tw("text-base font-semibold")
                    .color("#F9FAFB")

                  Text("Check the worker connection and try again.")
                    .tw("mt-2 text-xs text-center")
                    .color("#9CA3AF")
                }
                .slot("error")
                .tw("flex-1 w-full h-full min-h-0 items-center justify-center bg-gray-950 px-8")
              }
              .tw("flex-1 w-full min-h-0")
            }
            .tw("flex-1 w-full min-h-0 bg-white overflow-hidden")
          }
          .tw("flex-1 min-h-screen w-full overflow-hidden")
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
                        .tw("text-[15px] font-medium")
                        .color("#F9FAFB")
                      Text("@{state.wallpaperId == '${wallpaper.id}' ? 'Selected' : 'Wallpaper'}")
                        .tw("text-xs mt-0.5")
                        .color("#9CA3AF")
                    }
                    .tw("ml-3 flex-1")

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
                        .tw("text-[15px] font-medium")
                        .color("#F9FAFB")
                      Text("@{state.accentId == '${accent.id}' ? 'Selected' : 'Accent color'}")
                        .tw("text-xs mt-0.5")
                        .color("#9CA3AF")
                    }
                    .tw("ml-3 flex-1")

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
                  Text("‹ Home")
                    .tw("text-[17px] font-medium")
                    .color("@{state.accent}")
                }
                .onClick(@router.push, to: "/")
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
                  .tw("ml-3 flex-1")
                }
                .tw("items-center p-3")
              }
              .tw("w-full rounded-2xl bg-black/30 border border-white/10 overflow-hidden mt-5")
            }
            .tw("px-5 pt-2 w-full")
          }
          .background("@{state.wallpaper}")
          .tw("flex-1 min-h-screen w-full items-center overflow-auto pb-8")
        }`;
}

/** The full home-screen DSL, generated from APPS. Exported for tooling. */
export function buildLauncherTemplate(apps: LauncherApp[] = APPS): string {
  // The icon grid is rows of three. (The engine's Grid component is
  // data-driven — it wants an array binding — so a static launcher grid is
  // plain Rows.)
  const gridItems: Array<{ item: { name: string; resource: string; iconColor: string; tile: string }; to: string }> = [
    ...apps.map((a) => ({ item: a, to: `/app/${a.slug}` })),
    { item: SETTINGS_ICON, to: SETTINGS_ICON.route },
  ];
  const gridRows: (typeof gridItems)[] = [];
  for (let i = 0; i < gridItems.length; i += 3) {
    gridRows.push(gridItems.slice(i, i + 3));
  }
  const homeGrid = gridRows
    .map(
      (row) => `
            Row {
${row
  .map(({ item, to }) =>
    appIcon(item, to, {
      // Only the embedded apps have a splash slot to fly into; Settings
      // routes into the launcher itself, so it gets no key (an unmatched
      // key degrades to a plain navigation and warns in dev).
      sharedKey: to.startsWith("/app/") ? `app-${to.slice("/app/".length)}` : "",
    }),
  )
  .join("\n")}
            }
            .tw("items-start justify-between w-full")`,
    )
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
              Text("9:41")
                .tw("text-xs font-semibold")
                .color("#F9FAFB")
              Text("Hypen 5G  ▦  ▲")
                .tw("text-xs")
                .color("#F9FAFB")
            }
            .tw("items-center justify-between px-6 pt-3 pb-6 w-full")

            // ----- App grid -----
            Column {
${homeGrid}
            }
            .tw("gap-4 px-3 w-full max-w-[250px] md:max-w-[270px] lg:max-w-[290px]")

            Column {}
              .tw("flex-1")

            // ----- Dock -----
            Column {
              Row {
${dock}
              }
              .tw("items-center justify-between bg-black/25 border border-white/15 rounded-3xl px-3 py-2 w-full")
            }
            .tw("px-1 mb-4 w-full max-w-[260px] md:max-w-[280px] lg:max-w-[300px]")
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
export default app
  .defineState<LauncherState>({
    location: "/",
    wallpaperId: "torres",
    wallpaper: PHOTO_WALLPAPER,
    accentId: "blue",
    accent: ACCENTS[0]!.color,
    wallpapers: WALLPAPERS,
    accents: ACCENTS,
  })
  .persist(durableObjectStore<LauncherState>(withKey<LauncherState>(() => HOME_STATE_KEY)))
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
