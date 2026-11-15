import { app } from "@hypen-space/core";
import { categories, countryName, type Category, type CategoryKind } from "../radio-browser";
import { back, routeParam } from "../screen-actions";
import { tintFor } from "../tint";
import { C, MONO, errorCard, notice, screen, subHeader } from "../ui";

// /browse/:kind — genres (tags), countries, languages, live from Radio Browser.

interface CategoriesState {
  kind: CategoryKind;
  title: string;
  all: Tile[];
  shown: Tile[];
  /** "1,234 genres" — how many the directory lists. */
  total: string;
  filter: string;
  /** A filter that matches nothing. */
  noMatch: boolean;
  loading: boolean;
  failed: boolean;
  error: string;
}

/** A category plus what its tile shows: a colour and a formatted count. */
type Tile = Category & { tint: string; stations: string; label: string };

const fmt = new Intl.NumberFormat("en");

const TITLES: Record<CategoryKind, string> = {
  genres: "Genres",
  countries: "Countries",
  languages: "Languages",
};
const LIST_KIND: Record<CategoryKind, string> = { genres: "tag", countries: "country", languages: "language" };

function applyFilter(state: CategoriesState) {
  const q = state.filter.trim().toLowerCase();
  state.shown = q ? state.all.filter((c) => c.name.toLowerCase().includes(q)) : state.all;
  state.noMatch = q !== "" && state.shown.length === 0;
}

async function load(state: CategoriesState) {
  state.loading = true;
  state.failed = false;
  try {
    state.all = (await categories(state.kind)).map((c) => {
      // Radio Browser's country names are long-form ("The United States Of America").
      const name = state.kind === "countries" ? countryName(c.id) : c.name;
      return {
      ...c,
      name,
      // Flag and name in one text run (a flag-only Text draws as tofu on desktop).
      label: `${c.badge} ${name}`.trim(),
      tint: tintFor(c.name).tint,
      stations: `${fmt.format(c.count)} ${c.count === 1 ? "station" : "stations"}`,
      };
    });
    state.total = `${fmt.format(state.all.length)} ${state.title.toUpperCase()}`;
    applyFilter(state);
  } catch (err) {
    state.failed = true;
    state.error = `Couldn't load ${state.title.toLowerCase()} (${err instanceof Error ? err.message : "network error"}).`;
  } finally {
    state.loading = false;
  }
}

export default app
  .module("Categories")
  .defineState<CategoriesState>({
    kind: "genres",
    title: "Genres",
    all: [],
    shown: [],
    total: "",
    filter: "",
    noMatch: false,
    loading: true,
    failed: false,
    error: "",
  })
  .onActivated(async (state, context) => {
    const raw = routeParam(context, "/browse/:kind", "kind") as CategoryKind;
    const kind: CategoryKind = raw in TITLES ? raw : "genres";
    if (kind === state.kind && state.all.length && !state.failed) return;
    state.kind = kind;
    state.title = TITLES[kind];
    state.filter = "";
    state.all = [];
    state.shown = [];
    state.total = "";
    state.noMatch = false;
    await load(state);
  })
  .onAction("filter", ({ state }) => applyFilter(state))
  .onAction("clearFilter", ({ state }) => {
    state.filter = "";
    applyFilter(state);
  })
  .onAction("retry", async ({ state }) => load(state))
  .onAction("back", back)
  .onAction<{ slug?: string }>("pick", ({ action, state, context }) => {
    if (action.payload?.slug) context?.router?.push(`/list/${LIST_KIND[state.kind]}/${action.payload.slug}`);
  })
  .ui(
    screen(
      "Categories",
      `
${subHeader("@{state.title}", "", "BROWSE")}

          Row {
            Icon(@resources.search)
              .size(18)
              .color("${C.muted}")
            Input(placeholder: "Filter by name")
              .bind(@state.filter)
              .onInput(@actions.filter)
              .label("Filter")
              .tw("flex-1 min-w-0 h-[50px] ml-3 text-[15px] bg-transparent border-0")
              .color("${C.text}")
            Text("@{state.total}")
              .tw("text-[11px] ml-2 shrink-0")
              ${MONO}
              .color("${C.faint}")
          }
          .tw("w-full px-5 rounded-full items-center")
          .backgroundColor("${C.surface}")
          .border("1px solid ${C.lineStrong}")

          If(condition: "@{state.loading}") {
            Column {
${[0, 1, 2, 3, 4].map(() => `              Row {
                Box {}.tw("flex-1 h-[76px] rounded-[18px]").backgroundColor("${C.surface}")
                Box {}.tw("flex-1 h-[76px] rounded-[18px] ml-2.5").backgroundColor("${C.surface}")
              }
              .tw("w-full mb-2.5")`).join("\n")}
            }
            .tw("w-full mt-5")
            .animate(shimmer)
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }
          If(condition: "@{state.noMatch}") {
${notice("search", "Nothing by that name", "No entry matches your filter. Try fewer letters.", ["Clear filter", ".onClick(@actions.clearFilter)"])}
          }

          Grid(@state.shown, key: "id") {
            Button {
              Column {
                Text("@{item.label}")
                  .tw("text-[15px] font-bold text-left w-full")
                  .color("${C.text}")
                  .maxLines(1)
                  .textOverflow("ellipsis")
                Text("@{item.stations}")
                  .tw("text-[11px] mt-2.5 text-left")
                  ${MONO}
                  .color("rgba(244, 238, 225, 0.78)")
              }
              .tw("items-start w-full")
            }
            .tw("px-4 py-3.5 rounded-[18px] items-stretch min-w-0")
            .background("linear-gradient(135deg, @{item.tint} 0%, ${C.surface} 115%)")
            .border("1px solid ${C.line}")
            .opacity({ default: 1, hover: 0.86, active: 0.6 })
            .transition(140, easeOut)
            .onClick(@actions.pick, slug: "@{item.slug}")
          }
          .gridColumns({ default: 2, md: 4 })
          .tw("gap-2.5 mt-5 w-full")
`,
    ),
  );
