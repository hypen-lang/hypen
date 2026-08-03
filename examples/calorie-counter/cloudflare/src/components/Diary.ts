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
  .ui(diaryTemplate());

// One card per meal bucket. The template has one List per meal rather than a
// nested List(sections) + List(entries) — nested iteration in Hypen only has
// parse-level coverage right now, so four flat top-level arrays sidestep it.
// The four blocks are identical except for the state slot, so they're
// generated here instead of hand-copied.
function mealBlock(slot: Meal): string {
  const s = `state.${slot}`;
  return `
          Column {
            Row {
              Column {
                Text("@{${s}.icon}")
                  .tw("text-xl md:text-2xl")
              }
              .tw("w-11 h-11 md:w-12 md:h-12 rounded-xl bg-gray-50 items-center justify-center mr-3 shrink-0")

              Column {
                Text("@{${s}.label}")
                  .tw("text-[15px] md:text-base font-semibold")
                  .color("#111827")
                Text("@{${s}.progressLabel}")
                  .tw("text-xs mt-0.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")

              Button {
                Row {
                  Icon(@resources.plus)
                    .size(13)
                    .color("#EC4899")
                  Text("Add")
                    .tw("text-xs font-semibold ml-1")
                    .color("#EC4899")
                }
                .tw("items-center")
              }
              .tw("bg-pink-50 border border-pink-100 px-3 py-1.5 rounded-full")
              .opacity({ default: 1, active: 0.7 })
              .transition(150, easeOut)
              .onClick(@router.push, to: "@{${s}.addPath}")
            }
            .tw("items-center")

            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-pink-500")
                .width("@{${s}.progressWidth}")
                .transition(450, easeOut, props: [width])
            }
            .tw("mt-3 h-1.5 bg-gray-100 rounded-full w-full")

            If(condition: @${s}.isEmpty) {
              Text("Nothing logged yet")
                .tw("text-xs mt-3")
                .color("#9CA3AF")
            }

            List(@${s}.entries) {
              Row {
                Text("@{item.icon}")
                  .tw("text-xl md:text-2xl mr-2.5")
                Column {
                  Text("@{item.name}")
                    .tw("text-sm md:text-base font-medium")
                    .color("#111827")
                  Text("@{item.subtitle}")
                    .tw("text-xs mt-0.5")
                    .color("#9CA3AF")
                }
                .tw("flex-1")
                Button {
                  Icon(@resources.trash)
                    .size(15)
                    .color("#D1D5DB")
                }
                .tw("bg-transparent border-0 p-2")
                .opacity({ default: 1, active: 0.6 })
                .transition(150, easeOut)
                .onClick(@actions.removeEntry, entryId: "@{item.id}")
              }
              .tw("items-center py-2.5 border-t border-gray-100 mt-2")
              .enter(fade, duration: 240)
              .exit(fade, duration: 180)
            }
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-4 md:p-5 mb-3")
          .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
          .enter(slide, fade, from: bottom, duration: 280)`;
}

function diaryTemplate(): string {
  return `
    module Diary {
      Column {
        Row {
          Button {
            Icon(@resources.chevron-left)
              .size(18)
              .color("#6B7280")
          }
          .tw("bg-white border border-gray-100 w-9 h-9 rounded-full items-center justify-center ml-3")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.shiftDay, direction: "prev")

          Column {
            Text("Diary")
              .tw("text-[15px] md:text-base font-semibold")
              .color("#111827")
            Text("@{state.dateLabel}")
              .tw("text-xs mt-0.5")
              .color("#9CA3AF")
          }
          .tw("flex-1 items-center")

          Button {
            Icon(@resources.chevron-right)
              .size(18)
              .color("#6B7280")
          }
          .tw("bg-white border border-gray-100 w-9 h-9 rounded-full items-center justify-center mr-3")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.shiftDay, direction: "next")
        }
        .tw("px-2 py-3 items-center border-b border-gray-100 bg-white")

        Text("@{state.totalLabel}")
          .tw("px-4 pt-4 pb-2 text-[11px] font-semibold tracking-widest uppercase")
          .color("#9CA3AF")

        Column {
${mealBlock("breakfast")}
${mealBlock("lunch")}
${mealBlock("dinner")}
${mealBlock("snack")}
        }
        .tw("px-4 pt-1 pb-8")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-[#F8FAFC]")
    }
  `;
}
