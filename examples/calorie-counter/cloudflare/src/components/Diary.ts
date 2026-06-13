import { app } from "@hypen-space/core";
import {
  addDays,
  getDiary,
  getPrimaryUser,
  prettyDay,
  removeFoodEntry,
  todayStr,
  type DiarySection,
  type User,
} from "../queries";

// Diary — "/diary" or "/diary/:date". The day being viewed lives in
// the URL; prev/next push a new path and rely on the `onActivated`
// firing against the new route to refresh the screen's state.
//
// Layout note: the template has one List per meal bucket rather than a
// nested List(sections) + List(entries). Nested iteration in Hypen
// only has parse-level coverage right now — `@item.entries` inside an
// inner `ForEach` doesn't resolve against the outer iteration. Four
// flat top-level arrays sidestep the problem entirely.

type Meal = "breakfast" | "lunch" | "dinner" | "snack";

interface EntryView {
  id: string;
  icon: string;
  name: string;
  subtitle: string;
}

interface MealBlockView {
  meal: Meal;
  label: string;
  icon: string;
  entries: EntryView[];
  isEmpty: boolean;
  progressLabel: string;
  progressWidth: string;
  addPath: string;
}

interface DiaryState {
  date: string;
  dateLabel: string;
  totalLabel: string;
  breakfast: MealBlockView;
  lunch:     MealBlockView;
  dinner:    MealBlockView;
  snack:     MealBlockView;
}

function toBlock(s: DiarySection): MealBlockView {
  const pct = s.calorieGoal > 0
    ? Math.min(100, Math.round((s.caloriesEaten / s.calorieGoal) * 100))
    : 0;
  return {
    meal: s.meal,
    label: s.label,
    icon: s.icon,
    entries: s.entries.map((e) => ({
      id: e.id,
      icon: e.food.icon,
      name: e.food.name,
      subtitle: `${e.servings} × · ${e.calories} kcal`,
    })),
    isEmpty: s.entries.length === 0,
    progressLabel: `${s.caloriesEaten} / ${s.calorieGoal} kcal`,
    progressWidth: `${pct}%`,
    addPath: `/add/${s.meal}`,
  };
}

function emptyBlock(meal: Meal, label: string, icon: string): MealBlockView {
  return {
    meal,
    label,
    icon,
    entries: [],
    isEmpty: true,
    progressLabel: "0 / 0 kcal",
    progressWidth: "0%",
    addPath: `/add/${meal}`,
  };
}

function refresh(state: DiaryState, user: User, date: string) {
  state.date = date;
  state.dateLabel = prettyDay(date);
  const sections = getDiary(user.id, date);
  const bySlot: Record<Meal, MealBlockView | undefined> = {
    breakfast: undefined,
    lunch:     undefined,
    dinner:    undefined,
    snack:     undefined,
  };
  for (const s of sections) bySlot[s.meal] = toBlock(s);
  state.breakfast = bySlot.breakfast ?? emptyBlock("breakfast", "Breakfast", "🥪");
  state.lunch     = bySlot.lunch     ?? emptyBlock("lunch",     "Lunch",     "🍙");
  state.dinner    = bySlot.dinner    ?? emptyBlock("dinner",    "Dinner",    "🍝");
  state.snack     = bySlot.snack     ?? emptyBlock("snack",     "Snack",     "🍎");
  const total = sections.reduce((a, s) => a + s.caloriesEaten, 0);
  state.totalLabel = `${total} kcal logged`;
}

function isValidDate(d: string | undefined): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

export default app
  .module("Diary")
  .defineState<DiaryState>({
    date: todayStr(),
    dateLabel: prettyDay(todayStr()),
    totalLabel: "0 kcal logged",
    breakfast: emptyBlock("breakfast", "Breakfast", "🥪"),
    lunch:     emptyBlock("lunch",     "Lunch",     "🍙"),
    dinner:    emptyBlock("dinner",    "Dinner",    "🍝"),
    snack:     emptyBlock("snack",     "Snack",     "🍎"),
  })
  .onActivated(async (state, context) => {
    const user = getPrimaryUser();
    if (!user) return;
    const path = context?.router?.getCurrentPath() ?? "/diary";
    const match = context?.router?.matchPath("/diary/:date", path);
    const date = isValidDate(match?.params.date) ? match.params.date : todayStr();
    refresh(state, user, date);
  })
  .onAction<{ direction: "prev" | "next" }>("shiftDay", async ({ state, action, context }) => {
    if (!action.payload) return;
    const delta = action.payload.direction === "next" ? 1 : -1;
    const next = addDays(state.date, delta);
    context?.router?.push(`/diary/${next}`);
  })
  .onAction<{ entryId: string }>("removeEntry", async ({ state, action }) => {
    const user = getPrimaryUser();
    if (!user || !action.payload) return;
    removeFoodEntry(action.payload.entryId, user.id);
    refresh(state, user, state.date);
  })
  .ui(`
    module Diary {
      Column {
        Row {
          Button {
            Text("‹")
              .tw("text-lg md:text-xl")
              .color("#374151")
          }
          .tw("bg-transparent border-0 px-3 py-2")
          .onClick(@actions.shiftDay, direction: "prev")

          Column {
            Text("Diary")
              .tw("text-base md:text-lg font-semibold")
              .color("#111827")
            Text("@{state.dateLabel}")
              .tw("text-xs md:text-sm mt-0.5")
              .color("#9CA3AF")
          }
          .tw("flex-1 items-center")

          Button {
            Text("›")
              .tw("text-lg md:text-xl")
              .color("#374151")
          }
          .tw("bg-transparent border-0 px-3 py-2")
          .onClick(@actions.shiftDay, direction: "next")
        }
        .tw("px-2 py-3 items-center border-b border-gray-100")

        Text("@{state.totalLabel}")
          .tw("px-4 pt-3 pb-1 text-xs md:text-sm")
          .color("#9CA3AF")

        Column {
          // ----- Breakfast block -----
          Column {
            Row {
              Text("@{state.breakfast.icon}")
                .tw("text-2xl md:text-3xl mr-2")
              Column {
                Text("@{state.breakfast.label}")
                  .tw("text-base md:text-lg font-semibold")
                  .color("#111827")
                Text("@{state.breakfast.progressLabel}")
                  .tw("text-xs md:text-sm mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")
              Button {
                Text("+ Add")
                  .tw("text-xs md:text-sm font-semibold")
                  .color("#EC4899")
              }
              .tw("bg-pink-50 border-0 px-3 py-1.5 rounded-full")
              .onClick(@router.push, to: "@{state.breakfast.addPath}")
            }
            .tw("items-center")

            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-yellow-400")
                .width("@{state.breakfast.progressWidth}")
            }
            .tw("mt-2 h-1.5 bg-yellow-100 rounded-full w-full")

            If(condition: @state.breakfast.isEmpty) {
              Text("No items yet")
                .tw("text-xs md:text-sm mt-3 italic")
                .color("#9CA3AF")
            }

            List(@state.breakfast.entries) {
              Row {
                Text("@{item.icon}")
                  .tw("text-xl md:text-2xl mr-2")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm md:text-base font-medium")
                    .color("#111827")
                  Text("@{item.subtitle}")
                    .tw("text-xs md:text-sm mt-0.5")
                    .color("#9CA3AF")
                }
                .tw("flex-1")
                Button {
                  Text("🗑")
                    .tw("text-sm md:text-base")
                    .color("#9CA3AF")
                }
                .tw("bg-transparent border-0 p-2")
                .onClick(@actions.removeEntry, entryId: "@{item.id}")
              }
              .tw("items-center py-2 border-t border-gray-100 mt-2")
            }
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-4 md:p-5 mb-3")

          // ----- Lunch block -----
          Column {
            Row {
              Text("@{state.lunch.icon}")
                .tw("text-2xl md:text-3xl mr-2")
              Column {
                Text("@{state.lunch.label}")
                  .tw("text-base md:text-lg font-semibold")
                  .color("#111827")
                Text("@{state.lunch.progressLabel}")
                  .tw("text-xs md:text-sm mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")
              Button {
                Text("+ Add")
                  .tw("text-xs md:text-sm font-semibold")
                  .color("#EC4899")
              }
              .tw("bg-pink-50 border-0 px-3 py-1.5 rounded-full")
              .onClick(@router.push, to: "@{state.lunch.addPath}")
            }
            .tw("items-center")

            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-yellow-400")
                .width("@{state.lunch.progressWidth}")
            }
            .tw("mt-2 h-1.5 bg-yellow-100 rounded-full w-full")

            If(condition: @state.lunch.isEmpty) {
              Text("No items yet")
                .tw("text-xs md:text-sm mt-3 italic")
                .color("#9CA3AF")
            }

            List(@state.lunch.entries) {
              Row {
                Text("@{item.icon}")
                  .tw("text-xl md:text-2xl mr-2")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm md:text-base font-medium")
                    .color("#111827")
                  Text("@{item.subtitle}")
                    .tw("text-xs md:text-sm mt-0.5")
                    .color("#9CA3AF")
                }
                .tw("flex-1")
                Button {
                  Text("🗑")
                    .tw("text-sm md:text-base")
                    .color("#9CA3AF")
                }
                .tw("bg-transparent border-0 p-2")
                .onClick(@actions.removeEntry, entryId: "@{item.id}")
              }
              .tw("items-center py-2 border-t border-gray-100 mt-2")
            }
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-4 md:p-5 mb-3")

          // ----- Dinner block -----
          Column {
            Row {
              Text("@{state.dinner.icon}")
                .tw("text-2xl md:text-3xl mr-2")
              Column {
                Text("@{state.dinner.label}")
                  .tw("text-base md:text-lg font-semibold")
                  .color("#111827")
                Text("@{state.dinner.progressLabel}")
                  .tw("text-xs md:text-sm mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")
              Button {
                Text("+ Add")
                  .tw("text-xs md:text-sm font-semibold")
                  .color("#EC4899")
              }
              .tw("bg-pink-50 border-0 px-3 py-1.5 rounded-full")
              .onClick(@router.push, to: "@{state.dinner.addPath}")
            }
            .tw("items-center")

            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-yellow-400")
                .width("@{state.dinner.progressWidth}")
            }
            .tw("mt-2 h-1.5 bg-yellow-100 rounded-full w-full")

            If(condition: @state.dinner.isEmpty) {
              Text("No items yet")
                .tw("text-xs md:text-sm mt-3 italic")
                .color("#9CA3AF")
            }

            List(@state.dinner.entries) {
              Row {
                Text("@{item.icon}")
                  .tw("text-xl md:text-2xl mr-2")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm md:text-base font-medium")
                    .color("#111827")
                  Text("@{item.subtitle}")
                    .tw("text-xs md:text-sm mt-0.5")
                    .color("#9CA3AF")
                }
                .tw("flex-1")
                Button {
                  Text("🗑")
                    .tw("text-sm md:text-base")
                    .color("#9CA3AF")
                }
                .tw("bg-transparent border-0 p-2")
                .onClick(@actions.removeEntry, entryId: "@{item.id}")
              }
              .tw("items-center py-2 border-t border-gray-100 mt-2")
            }
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-4 md:p-5 mb-3")

          // ----- Snack block -----
          Column {
            Row {
              Text("@{state.snack.icon}")
                .tw("text-2xl md:text-3xl mr-2")
              Column {
                Text("@{state.snack.label}")
                  .tw("text-base md:text-lg font-semibold")
                  .color("#111827")
                Text("@{state.snack.progressLabel}")
                  .tw("text-xs md:text-sm mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")
              Button {
                Text("+ Add")
                  .tw("text-xs md:text-sm font-semibold")
                  .color("#EC4899")
              }
              .tw("bg-pink-50 border-0 px-3 py-1.5 rounded-full")
              .onClick(@router.push, to: "@{state.snack.addPath}")
            }
            .tw("items-center")

            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-yellow-400")
                .width("@{state.snack.progressWidth}")
            }
            .tw("mt-2 h-1.5 bg-yellow-100 rounded-full w-full")

            If(condition: @state.snack.isEmpty) {
              Text("No items yet")
                .tw("text-xs md:text-sm mt-3 italic")
                .color("#9CA3AF")
            }

            List(@state.snack.entries) {
              Row {
                Text("@{item.icon}")
                  .tw("text-xl md:text-2xl mr-2")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm md:text-base font-medium")
                    .color("#111827")
                  Text("@{item.subtitle}")
                    .tw("text-xs md:text-sm mt-0.5")
                    .color("#9CA3AF")
                }
                .tw("flex-1")
                Button {
                  Text("🗑")
                    .tw("text-sm md:text-base")
                    .color("#9CA3AF")
                }
                .tw("bg-transparent border-0 p-2")
                .onClick(@actions.removeEntry, entryId: "@{item.id}")
              }
              .tw("items-center py-2 border-t border-gray-100 mt-2")
            }
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-4 md:p-5 mb-3")
        }
        .tw("px-4 pt-2 pb-8")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-white")
    }
  `);
