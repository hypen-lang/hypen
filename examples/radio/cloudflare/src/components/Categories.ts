import { app } from "@hypen-space/core";
import { categories, type Category, type CategoryKind } from "../radio-browser";
import { back, routeParam } from "../screen-actions";
import { C, errorCard, screen, skeletonRows, subHeader } from "../ui";

// /browse/:kind — genres (tags), countries, languages, live from Radio Browser.

interface CategoriesState {
  kind: CategoryKind;
  title: string;
  all: Category[];
  shown: Category[];
  filter: string;
  loading: boolean;
  failed: boolean;
  error: string;
}

const TITLES: Record<CategoryKind, string> = {
  genres: "Genres",
  countries: "Countries",
  languages: "Languages",
};
const LIST_KIND: Record<CategoryKind, string> = { genres: "tag", countries: "country", languages: "language" };

function applyFilter(state: CategoriesState) {
  const q = state.filter.trim().toLowerCase();
  state.shown = q ? state.all.filter((c) => c.name.toLowerCase().includes(q)) : state.all;
}

async function load(state: CategoriesState) {
  state.loading = true;
  state.failed = false;
  try {
    state.all = await categories(state.kind);
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
    filter: "",
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
    await load(state);
  })
  .onAction("filter", ({ state }) => applyFilter(state))
  .onAction("retry", async ({ state }) => load(state))
  .onAction("back", back)
  .onAction<{ slug?: string }>("pick", ({ action, state, context }) => {
    if (action.payload?.slug) context?.router?.push(`/list/${LIST_KIND[state.kind]}/${action.payload.slug}`);
  })
  .ui(
    screen(
      "Categories",
      `
${subHeader("@{state.title}")}

          Input(placeholder: "Filter")
            .bind(@state.filter)
            .onInput(@actions.filter)
            .label("Filter")
            .tw("w-full h-11 px-4 rounded-xl text-sm")
            .backgroundColor("${C.surface}")
            .color("${C.text}")
            .border("1px solid ${C.line}")

          If(condition: "@{state.loading}") {
            Column {
${skeletonRows(8)}
            }
            .tw("w-full mt-2")
          }
          If(condition: "@{state.failed}") {
${errorCard("@{state.error}")}
          }

          Grid(@state.shown, key: "id") {
            Button {
              Row {
                Text("@{item.badge}")
                  .tw("text-lg mr-2")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm font-semibold text-left")
                    .color("${C.text}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("@{item.count} stations")
                    .tw("text-[11px] mt-0.5 text-left")
                    .color("${C.faint}")
                }
                .tw("flex-1 min-w-0 items-start")
              }
              .tw("items-center w-full")
            }
            .tw("px-3.5 py-3 rounded-xl border-0 items-stretch min-w-0")
            .backgroundColor({ default: "${C.surface}", hover: "${C.surface2}" })
            .opacity({ default: 1, active: 0.6 })
            .onClick(@actions.pick, slug: "@{item.slug}")
          }
          .gridColumns({ default: 2, md: 3 })
          .tw("gap-2 mt-4 w-full")
`,
    ),
  );
