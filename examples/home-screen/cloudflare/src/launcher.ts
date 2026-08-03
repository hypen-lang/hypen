import { app } from "@hypen-space/core";
import { durableObjectStore, global } from "@hypen-space/cf";

// Hypen Home — a phone-style home screen that launches OTHER Hypen apps.
//
// Each app icon routes to a full-screen frame whose body is a single
// built-in `HypenApp("<ws-url>")` component — it connects to a remote Hypen
// app over WebSocket and renders its patches inline. Since every example in
// this repo deploys as a Cloudflare Worker, "installing an app" here is
// literally just a URL.
//
// The ⚙ Settings icon opens a route of the launcher itself (no embed):
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
  /** Emoji used as the icon glyph. */
  icon: string;
  /** Tailwind classes for the icon tile background. */
  tile: string;
  /**
   * WebSocket endpoint of the deployed example. Defaults assume each sibling
   * example is running locally on its own port (see README). After deploying
   * the siblings, swap these for their wss://...workers.dev/ws URLs.
   */
  url: string;
}

export const APPS: LauncherApp[] = [
  {
    slug: "counter",
    name: "Counter",
    icon: "🔢",
    tile: "bg-gradient-to-br from-sky-400 to-blue-600",
    url: "ws://localhost:8788/ws",
  },
  {
    slug: "todo",
    name: "Todo",
    icon: "✅",
    tile: "bg-gradient-to-br from-indigo-400 to-violet-600",
    url: "ws://localhost:8789/ws",
  },
  {
    slug: "calculator",
    name: "Calculator",
    icon: "🧮",
    tile: "bg-gradient-to-br from-slate-500 to-slate-800",
    url: "ws://localhost:8794/ws",
  },
  {
    slug: "calories",
    name: "Calories",
    icon: "🥗",
    tile: "bg-gradient-to-br from-pink-400 to-rose-600",
    url: "ws://localhost:8790/ws",
  },
  {
    slug: "movies",
    name: "Movies",
    icon: "🎬",
    tile: "bg-gradient-to-br from-amber-400 to-orange-600",
    url: "ws://localhost:8791/ws",
  },
  {
    slug: "food",
    name: "Food",
    icon: "🍔",
    tile: "bg-gradient-to-br from-emerald-400 to-green-600",
    url: "ws://localhost:8792/ws",
  },
  {
    slug: "social",
    name: "Social",
    icon: "💬",
    tile: "bg-gradient-to-br from-fuchsia-400 to-purple-600",
    url: "ws://localhost:8793/ws",
  },
];

// The Settings "app" lives on the grid like any other icon but routes into
// the launcher's own /settings screen instead of embedding a remote app.
const SETTINGS_ICON = {
  slug: "settings",
  name: "Settings",
  icon: "⚙️",
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

const WALLPAPERS: Wallpaper[] = [
  { id: "indigo", name: "Indigo Night", css: "linear-gradient(180deg, #312e81, #0f172a)", selected: true },
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
  /** Current wallpaper CSS — bound by `.background(...)` on every screen. */
  wallpaper: string;
  /** Current accent color — tints back buttons, titles, and checkmarks. */
  accent: string;
  wallpapers: Wallpaper[];
  accents: Accent[];
}

/** One tappable icon (tile + label) for the home grid or the dock. */
function appIcon(
  a: { name: string; icon: string; tile: string },
  to: string,
  { label = true } = {},
): string {
  return `
          Button {
            Column {
              Column {
                Text("${a.icon}")
                  .tw("text-3xl")
              }
              .tw("w-16 h-16 rounded-2xl ${a.tile} items-center justify-center shadow-lg")
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

              Text("${a.icon} ${a.name}")
                .tw("text-sm font-semibold")
                .color("#F9FAFB")

              // Spacer to balance the back button so the title centers.
              Column {}
                .tw("w-16")
            }
            .tw("items-center justify-between px-3 py-3 bg-gray-900")

            Column {
              HypenApp("${a.url}")
            }
            .tw("flex-1 bg-white overflow-auto")
          }
          .tw("flex-1 min-h-screen")
        }`;
}

/** The launcher's own Settings screen — wallpaper + accent pickers. */
function settingsRoute(): string {
  return `
        Route(path: "/settings") {
          Column {
            Row {
              Button {
                Text("‹ Home")
                  .tw("text-sm font-semibold")
                  .color("@{state.accent}")
              }
              .onClick(@router.push, to: "/")
              .tw("bg-transparent border-0 px-2 py-1")

              Text("⚙️ Settings")
                .tw("text-sm font-semibold")
                .color("#F9FAFB")

              Column {}
                .tw("w-16")
            }
            .tw("items-center justify-between px-3 py-3 w-full")

            Column {
              Text("WALLPAPER")
                .tw("text-xs font-semibold tracking-wide mt-2 mb-2")
                .color("#9CA3AF")

              List(@state.wallpapers) {
                Button {
                  Row {
                    Box {}
                      .background("@{item.css}")
                      .tw("w-12 h-12 rounded-xl border border-white/20")

                    Text("@{item.name}")
                      .tw("text-sm font-medium ml-3 flex-1 text-left")
                      .color("#F9FAFB")

                    Text("@{item.selected ? '✓' : ''}")
                      .tw("text-base font-bold")
                      .color("@{state.accent}")
                  }
                  .tw("items-center w-full")
                }
                .onClick(@actions.setWallpaper, id: "@{item.id}")
                .tw("bg-white/10 border-0 rounded-2xl p-3 mb-2 w-full")
              }
              .tw("w-full")

              Text("ACCENT")
                .tw("text-xs font-semibold tracking-wide mt-4 mb-2")
                .color("#9CA3AF")

              Row {
                List(@state.accents) {
                  Button {
                    Column {
                      Text("@{item.selected ? '✓' : ''}")
                        .tw("text-base font-bold")
                        .color("#111827")
                    }
                    .background("@{item.color}")
                    .tw("w-11 h-11 rounded-full items-center justify-center border-2 border-white/30")
                  }
                  .onClick(@actions.setAccent, id: "@{item.id}")
                  .tw("bg-transparent border-0 p-1")
                }
                .tw("flex flex-row")
              }
              .tw("w-full")
            }
            .tw("px-5 w-full max-w-sm")
          }
          .background("@{state.wallpaper}")
          .tw("flex-1 min-h-screen items-center")
        }`;
}

/** The full home-screen DSL, generated from APPS. Exported for tooling. */
export function buildLauncherTemplate(apps: LauncherApp[] = APPS): string {
  // The icon grid is rows of three. (The engine's Grid component is
  // data-driven — it wants an array binding — so a static launcher grid is
  // plain Rows.)
  const gridItems: Array<{ item: { name: string; icon: string; tile: string }; to: string }> = [
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
${row.map(({ item, to }) => appIcon(item, to)).join("\n")}
            }
            .tw("items-start justify-around w-full")`,
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
            .tw("gap-6 px-6 w-full max-w-sm")

            Column {}
              .tw("flex-1")

            // ----- Dock -----
            Row {
${dock}
            }
            .tw("items-center justify-around bg-white/10 rounded-3xl mx-4 mb-4 px-4 py-3 w-full max-w-sm")
          }
          .background("@{state.wallpaper}")
          .tw("flex-1 min-h-screen items-center")
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
    wallpaper: WALLPAPERS[0]!.css,
    accent: ACCENTS[0]!.color,
    wallpapers: WALLPAPERS,
    accents: ACCENTS,
  })
  .persist(durableObjectStore<LauncherState>(global<LauncherState>()))
  .onAction<{ id: string }>("setWallpaper", ({ action, state }) => {
    const id = action.payload?.id;
    const wp = state.wallpapers.find((w) => w.id === id);
    if (!wp) return;
    state.wallpaper = wp.css;
    state.wallpapers = state.wallpapers.map((w) => ({ ...w, selected: w.id === id }));
  })
  .onAction<{ id: string }>("setAccent", ({ action, state }) => {
    const id = action.payload?.id;
    const accent = state.accents.find((a) => a.id === id);
    if (!accent) return;
    state.accent = accent.color;
    state.accents = state.accents.map((a) => ({ ...a, selected: a.id === id }));
  })
  .ui(buildLauncherTemplate());
