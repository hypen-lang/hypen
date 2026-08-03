import { app } from "@hypen-space/core";
import {
  getFoods,
  getPrimaryUser,
  getRecentFoods,
  logFoodEntry,
  todayStr,
  type Food,
} from "../queries";

// AddFood — "/add/:meal". The meal bucket the user is adding into is
// the URL param — no shared App state involved. Logging a food writes
// against today's date; navigating back returns to Home.

type Category = "all" | "recent" | "meals" | "my-foods";
type Meal = "breakfast" | "lunch" | "dinner" | "snack";

interface CategoryTab {
  id: Category;
  label: string;
  icon: string;
  active: boolean;
}

interface FoodRow extends Food {
  subtitle: string;
  // True once the user has logged this food at least once during this
  // visit. Drives the pink "+" → green "✓" pill swap so the user can
  // see at a glance what they've already added.
  added: boolean;
}

interface AddFoodState {
  // Captured from the `:meal` route param on activate and used as the
  // logging target. Drives the header subtitle ("Adding to Lunch").
  meal: Meal;
  mealLabel: string;
  searchQuery: string;
  category: Category;
  tabs: CategoryTab[];
  foods: FoodRow[];
  header: string;
  emptyMessage: string;
  isEmpty: boolean;
  // How many foods the user has logged during this visit to AddFood.
  // Reset every `onActivated` so it only ever reflects the current
  // session. Surfaced in the subtitle as "Lunch · 2 added".
  addedCount: number;
  // Ids of every food logged during this visit. Used to paint those
  // rows' pill green with a ✓. Same food tapped twice counts twice in
  // `addedCount` but only appears once in this list.
  addedIds: string[];
}

const BASE_TABS: Array<Omit<CategoryTab, "active">> = [
  { id: "all",      label: "All",      icon: "⏹" },
  { id: "recent",   label: "Recent",   icon: "⏱" },
  { id: "meals",    label: "Meals",    icon: "🍲" },
  { id: "my-foods", label: "My Foods", icon: "♡" },
];

const MEAL_LABELS: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch:     "Lunch",
  dinner:    "Dinner",
  snack:     "Snack",
};

function tabsFor(active: Category): CategoryTab[] {
  return BASE_TABS.map((t) => ({ ...t, active: t.id === active }));
}

function subtitleFor(f: Food): string {
  return `${f.calories} kcal · ${f.servingLabel}`;
}

function headerFor(c: Category): string {
  return c === "all" ? "Popular" : c === "recent" ? "Recent" : c === "meals" ? "Meals" : "My Foods";
}

function normaliseMeal(raw: string | undefined): Meal {
  return raw === "lunch" || raw === "dinner" || raw === "snack" ? raw : "breakfast";
}

function refreshFoods(state: AddFoodState, userId: string) {
  const q = state.searchQuery;
  let raw: Food[];
  if (state.category === "recent") {
    raw = getRecentFoods(userId);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      raw = raw.filter((f) => f.name.toLowerCase().includes(needle));
    }
  } else if (state.category === "meals") {
    raw = getFoods("meal", q);
  } else if (state.category === "my-foods") {
    raw = getFoods("my-food", q);
  } else {
    raw = getFoods(null, q);
  }
  const addedSet = new Set(state.addedIds);
  state.foods = raw.map((f) => ({
    ...f,
    subtitle: subtitleFor(f),
    added: addedSet.has(f.id),
  }));
  state.header = headerFor(state.category);
  state.emptyMessage = q.trim()
    ? `No foods match "${q.trim()}"`
    : "Nothing here yet — seed some data to get started.";
  state.isEmpty = state.foods.length === 0;
}

export default app
  .module("AddFood")
  .defineState<AddFoodState>({
    meal: "breakfast",
    mealLabel: "Breakfast",
    searchQuery: "",
    category: "all",
    tabs: tabsFor("all"),
    foods: [],
    header: "Popular",
    emptyMessage: "",
    isEmpty: true,
    addedCount: 0,
    addedIds: [],
  })
  .onActivated(async (state, context) => {
    // Pull the meal out of the /add/:meal route match. Default to
    // breakfast on a deep link with no param.
    const path = context?.router?.getCurrentPath() ?? "/add/breakfast";
    const match = context?.router?.matchPath("/add/:meal", path);
    const meal = normaliseMeal(match?.params.meal);
    state.meal = meal;
    state.mealLabel = MEAL_LABELS[meal];
    state.searchQuery = "";
    state.category = "all";
    state.tabs = tabsFor("all");
    state.addedCount = 0;
    state.addedIds = [];
    const user = getPrimaryUser();
    if (user) refreshFoods(state, user.id);
    else state.isEmpty = true;
  })
  .onAction("search", async ({ state }) => {
    const user = getPrimaryUser();
    if (!user) return;
    refreshFoods(state, user.id);
  })
  .onAction<{ category: Category }>("selectCategory", async ({ state, action }) => {
    const user = getPrimaryUser();
    if (!user || !action.payload) return;
    state.category = action.payload.category;
    state.tabs = tabsFor(state.category);
    refreshFoods(state, user.id);
  })
  .onAction<{ foodId: string }>("addFood", async ({ state, action }) => {
    const user = getPrimaryUser();
    if (!user || !action.payload) return;
    logFoodEntry(user.id, action.payload.foodId, state.meal, 1, todayStr());
    state.addedCount += 1;
    if (!state.addedIds.includes(action.payload.foodId)) {
      state.addedIds = [...state.addedIds, action.payload.foodId];
    }
    state.mealLabel = `${MEAL_LABELS[state.meal]} · ${state.addedCount} added`;
    refreshFoods(state, user.id);
  })
  .onAction("close", async ({ context }) => {
    context?.router?.push("/");
  })
  .onAction("confirm", async ({ context }) => {
    context?.router?.push("/");
  })
  .ui(`
    module AddFood {
      Column {
        // ----- Top bar: X | "Add Food · Meal" | ✓ -----
        Row {
          Button {
            Icon(@resources.x)
              .size(19)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 p-2.5")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.close)

          Column {
            Text("Add Food")
              .tw("text-[15px] md:text-base font-semibold text-center")
              .color("#111827")
            Text("@{state.mealLabel}")
              .tw("text-xs mt-0.5 text-center")
              .color("#9CA3AF")
          }
          .tw("flex-1")

          Button {
            Icon(@resources.check)
              .size(19)
              .color("#EC4899")
          }
          .tw("bg-transparent border-0 p-2.5")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.confirm)
        }
        .tw("px-2 py-2.5 items-center border-b border-gray-100")

        // ----- Search box -----
        Row {
          Icon(@resources.search)
            .size(16)
            .color("#9CA3AF")
          Input(placeholder: "Search for a food")
            .bind(@state.searchQuery)
            .onInput(@actions.search)
            .tw("flex-1 bg-transparent border-0 outline-none ml-2.5")
            .fontSize(15)
        }
        .tw("mx-4 my-3 px-4 py-3 bg-gray-100 rounded-xl items-center")

        // ----- Category tabs (segmented control) -----
        Row {
          List(@state.tabs) {
            Button {
              Text("@{item.label}")
                .tw("text-[13px] font-semibold")
                .color("@{item.active ? '#111827' : '#6B7280'}")
            }
            .tw("flex-1 py-2 border-0 rounded-lg items-center justify-center")
            .backgroundColor("@{item.active ? '#FFFFFF' : 'transparent'}")
            .transition(200, easeOut, props: [backgroundColor])
            .boxShadow("@{item.active ? '0 1px 4px rgba(17, 24, 39, 0.10)' : 'none'}")
            .onClick(@actions.selectCategory, category: "@{item.id}")
          }
          .tw("flex flex-row flex-1 items-center")
        }
        .tw("mx-4 p-1 bg-gray-100 rounded-xl items-center")

        // ----- Section header -----
        Row {
          Text("@{state.header}")
            .tw("flex-1 text-[15px] md:text-base font-semibold")
            .color("#111827")
        }
        .tw("px-4 pt-5 pb-1 items-center")

        // ----- Food list -----
        Column {
          List(@state.foods) {
            Row {
              Column {
                Text("@{item.icon}")
                  .tw("text-2xl md:text-3xl")
              }
              .tw("w-11 h-11 md:w-12 md:h-12 rounded-xl bg-gray-50 items-center justify-center mr-3 shrink-0")

              Column {
                Text("@{item.name}")
                  .tw("text-[15px] md:text-base font-medium")
                  .color("#111827")
                Text("@{item.subtitle}")
                  .tw("text-xs md:text-sm mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")

              Button {
                If(condition: "@{item.added}") {
                  Icon(@resources.check)
                    .size(15)
                    .color("#ffffff")
                }
                If(condition: "@{!item.added}") {
                  Icon(@resources.plus)
                    .size(15)
                    .color("#ffffff")
                }
              }
              .tw("border-0 w-9 h-9 rounded-full items-center justify-center")
              .backgroundColor("@{item.added ? '#10B981' : '#EC4899'}")
              .transition(220, easeOut, props: [backgroundColor])
              .opacity({ default: 1, active: 0.7 })
              .transition(150, easeOut)
              .onClick(@actions.addFood, foodId: "@{item.id}")
            }
            .tw("items-center px-4 py-2.5 border-b border-gray-50")
            .enter(fade, duration: 240)
          }

          If(condition: @state.isEmpty) {
            Column {
              Text("@{state.emptyMessage}")
                .tw("text-sm text-center")
                .color("#9CA3AF")
            }
            .tw("py-8 px-4 items-center")
          }
        }
        .tw("pb-8")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-white")
    }
  `);
