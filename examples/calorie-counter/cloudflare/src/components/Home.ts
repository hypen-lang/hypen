import { app } from "@hypen-space/core";
import {
  getActivities,
  getDaySummary,
  getMealBuckets,
  getPrimaryUser,
  logActivity,
  prettyDay,
  todayStr,
  type Activity,
  type DaySummary,
  type MealBucket,
  type User,
} from "../queries";

// Home — dashboard at "/". Always shows today; no shared App state.
// Every `onActivated` query reads `getPrimaryUser()` straight from the
// DB, so we don't depend on App shell hydration order.
//
// Writes that used to poke App's `activeMeal`/`currentDate` now go
// straight to the URL: tapping a meal card pushes `/add/<meal>`.

interface MealCardView extends MealBucket {
  // Dupe of `meal` so `List(@state.mealCards)` (which keys on "id")
  // has a stable identifier per card.
  id: string;
  progressLabel: string;
  // "53%" string, pre-baked so .width() binds to it directly.
  progressWidth: string;
}

interface ActivityView extends Activity {
  label: string;
}

interface HomeState {
  date: string;
  dateLabel: string;
  summary: DaySummary;
  mealCards: MealCardView[];
  activities: ActivityView[];
  // Hero-row derived fields. Kept flat so the template stays boring.
  kcalLeft: number;
  carbsLabel: string;
  proteinLabel: string;
  fatLabel: string;
  carbsWidth: string;
  proteinWidth: string;
  fatWidth: string;
}

const DEFAULT_SUMMARY: DaySummary = {
  date: todayStr(),
  label: prettyDay(todayStr()),
  caloriesEaten: 0,
  caloriesBurned: 0,
  calorieGoal: 2400,
  carbsG: 0,
  proteinG: 0,
  fatG: 0,
};

function activityLabel(type: Activity["type"]): string {
  return type === "walking" ? "Walking" : "Activity";
}

function pctWidth(num: number, denom: number): string {
  if (denom <= 0) return "0%";
  return `${Math.min(100, Math.max(0, Math.round((num / denom) * 100)))}%`;
}

function refresh(state: HomeState, user: User, date: string) {
  const summary = getDaySummary(user, date);
  const meals = getMealBuckets(user.id, date);
  const acts = getActivities(user.id, date);

  state.date = date;
  state.dateLabel = summary.label;
  state.summary = summary;
  state.mealCards = meals.map((m) => ({
    ...m,
    id: m.meal,
    progressLabel: `${m.caloriesEaten} / ${m.calorieGoal} kcal`,
    progressWidth: pctWidth(m.caloriesEaten, m.calorieGoal),
  }));
  state.activities = acts.map((a) => ({ ...a, label: activityLabel(a.type) }));

  state.kcalLeft = Math.max(0, summary.calorieGoal - summary.caloriesEaten + summary.caloriesBurned);
  state.carbsLabel = `${summary.carbsG} / ${user.carbsGoalG} g`;
  state.proteinLabel = `${summary.proteinG} / ${user.proteinGoalG} g`;
  state.fatLabel = `${summary.fatG} / ${user.fatGoalG} g`;
  state.carbsWidth = pctWidth(summary.carbsG, user.carbsGoalG);
  state.proteinWidth = pctWidth(summary.proteinG, user.proteinGoalG);
  state.fatWidth = pctWidth(summary.fatG, user.fatGoalG);
}

export default app
  .module("Home")
  .defineState<HomeState>({
    date: todayStr(),
    dateLabel: prettyDay(todayStr()),
    summary: DEFAULT_SUMMARY,
    mealCards: [],
    activities: [],
    kcalLeft: 2400,
    carbsLabel: "0 / 0 g",
    proteinLabel: "0 / 0 g",
    fatLabel: "0 / 0 g",
    carbsWidth: "0%",
    proteinWidth: "0%",
    fatWidth: "0%",
  })
  .onActivated(async (state) => {
    const user = getPrimaryUser();
    if (!user) return;
    refresh(state, user, todayStr());
  })
  .onAction("logWalkingStep", async ({ state }) => {
    const user = getPrimaryUser();
    if (!user) return;
    // One quick 100-kcal walk log — matches the "+ Walking" tile
    // interaction in the design.
    logActivity(user.id, "walking", 100, state.date);
    refresh(state, user, state.date);
  })
  .ui(`
    module Home {
      Column {
        // ----- Top bar -----
        Row {
          Button {
            Icon(@resources.settings)
              .size(20)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 p-2")
          .onClick(@router.push, to: "/profile")

          Column {
            Text("@{state.dateLabel}")
              .tw("text-[15px] md:text-base font-semibold")
              .color("#111827")
          }
          .tw("flex-1 items-center")

          Button {
            Icon(@resources.bell)
              .size(20)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 p-2")
        }
        .tw("px-4 pt-4 pb-2 items-center")

        // ----- Hero: Eaten | kcal left | Burned -----
        Row {
          Column {
            Text("Eaten")
              .tw("text-xs font-medium")
              .color("#9CA3AF")
            Text("@{state.summary.caloriesEaten}")
              .tw("text-2xl md:text-3xl font-bold mt-1")
              .color("#111827")
            Text("kcal")
              .tw("text-xs mt-0.5")
              .color("#9CA3AF")
          }
          .tw("flex-1 items-center")

          // Big center "ring" — the layered pink border stands in for the
          // real ring chart in the design.
          Column {
            Text("@{state.kcalLeft}")
              .tw("text-3xl md:text-4xl font-bold tracking-tight")
              .color("#111827")
            Text("kcal left")
              .tw("text-xs md:text-sm mt-1")
              .color("#9CA3AF")
          }
          .tw("w-32 h-32 md:w-40 md:h-40 lg:w-44 lg:h-44 rounded-full border-8 border-pink-100 items-center justify-center bg-white")
          .boxShadow("0 10px 30px rgba(236, 72, 153, 0.14)")

          Column {
            Text("Burned")
              .tw("text-xs font-medium")
              .color("#9CA3AF")
            Text("@{state.summary.caloriesBurned}")
              .tw("text-2xl md:text-3xl font-bold mt-1")
              .color("#111827")
            Text("kcal")
              .tw("text-xs mt-0.5")
              .color("#9CA3AF")
          }
          .tw("flex-1 items-center")
        }
        .tw("px-4 py-4 items-center")

        // ----- Macros -----
        Text("MACROS")
          .tw("px-4 pt-2 pb-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        Row {
          Column {
            Text("Carbs")
              .tw("text-xs font-medium")
              .color("#6B7280")
            Text("@{state.summary.carbsG} g")
              .tw("text-lg md:text-xl font-bold mt-1")
              .color("#111827")
            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-pink-500")
                .width("@{state.carbsWidth}")
                .transition(450, easeOut, props: [width])
            }
            .tw("mt-2.5 h-1.5 bg-gray-100 rounded-full w-full")
            Text("@{state.carbsLabel}")
              .tw("text-[11px] mt-2")
              .color("#9CA3AF")
          }
          .tw("flex-1 bg-white rounded-2xl p-3.5 md:p-4 border border-gray-100 items-start")
          .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")

          Column {
            Text("Protein")
              .tw("text-xs font-medium")
              .color("#6B7280")
            Text("@{state.summary.proteinG} g")
              .tw("text-lg md:text-xl font-bold mt-1")
              .color("#111827")
            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-amber-400")
                .width("@{state.proteinWidth}")
                .transition(450, easeOut, props: [width])
            }
            .tw("mt-2.5 h-1.5 bg-gray-100 rounded-full w-full")
            Text("@{state.proteinLabel}")
              .tw("text-[11px] mt-2")
              .color("#9CA3AF")
          }
          .tw("flex-1 bg-white rounded-2xl p-3.5 md:p-4 border border-gray-100 items-start ml-2.5")
          .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")

          Column {
            Text("Fat")
              .tw("text-xs font-medium")
              .color("#6B7280")
            Text("@{state.summary.fatG} g")
              .tw("text-lg md:text-xl font-bold mt-1")
              .color("#111827")
            Row {
              Box {}
                .tw("h-1.5 rounded-full bg-violet-400")
                .width("@{state.fatWidth}")
                .transition(450, easeOut, props: [width])
            }
            .tw("mt-2.5 h-1.5 bg-gray-100 rounded-full w-full")
            Text("@{state.fatLabel}")
              .tw("text-[11px] mt-2")
              .color("#9CA3AF")
          }
          .tw("flex-1 bg-white rounded-2xl p-3.5 md:p-4 border border-gray-100 items-start ml-2.5")
          .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
        }
        .tw("px-4")

        // ----- Activity -----
        Text("ACTIVITY")
          .tw("px-4 pt-5 pb-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        Row {
          List(@state.activities) {
            Column {
              Row {
                Icon(@resources.flame)
                  .size(13)
                  .color("#F59E0B")
                Text("@{item.label}")
                  .tw("text-xs font-medium ml-1")
                  .color("#6B7280")
              }
              .tw("items-center")
              Text("@{item.calories} kcal")
                .tw("text-lg md:text-xl font-bold mt-1.5")
                .color("#111827")
            }
            .tw("flex-1 bg-white rounded-2xl p-3.5 md:p-4 border border-gray-100 items-start mr-2.5")
            .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
          }
          .tw("flex flex-row flex-1")

          Button {
            Icon(@resources.plus)
              .size(18)
              .color("#EC4899")
          }
          .tw("bg-pink-50 border border-pink-100 w-12 h-12 md:w-14 md:h-14 rounded-2xl items-center justify-center shrink-0")
          .enter(fade, duration: 300)
          .opacity({ default: 1, active: 0.7 })
          .transition(150, easeOut)
          .onClick(@actions.logWalkingStep)
        }
        .tw("px-4 items-center")

        // ----- Meals list -----
        Text("MEALS")
          .tw("px-4 pt-5 pb-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        List(@state.mealCards) {
          Button {
            Row {
              Column {
                Text("@{item.icon}")
                  .tw("text-2xl md:text-3xl")
              }
              .tw("w-12 h-12 md:w-14 md:h-14 rounded-xl bg-gray-50 items-center justify-center mr-3 shrink-0")

              Column {
                Row {
                  Text("@{item.label}")
                    .tw("text-[15px] md:text-base font-semibold")
                    .color("#111827")
                  If(condition: "@{item.hasLogged}") {
                    Icon(@resources.check)
                      .size(14)
                      .color("#EC4899")
                  }
                }
                .tw("items-center gap-1.5")

                Row {
                  Box {}
                    .tw("h-1.5 rounded-full bg-pink-500")
                    .width("@{item.progressWidth}")
                    .transition(450, easeOut, props: [width])
                }
                .tw("mt-2 h-1.5 bg-gray-100 rounded-full w-full")

                Text("@{item.progressLabel}")
                  .tw("text-xs mt-1.5")
                  .color("#9CA3AF")
              }
              .tw("flex-1")

              Icon(@resources.chevron-right)
                .size(18)
                .color("#D1D5DB")
            }
            .tw("items-center")
          }
          .tw("bg-white border border-gray-100 rounded-2xl p-3.5 md:p-4 mb-2.5 w-full")
          .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
          .opacity({ default: 1, active: 0.75 })
          .transition(160, easeOut)
          .enter(slide, fade, from: bottom, duration: 280)
          // Tap a meal → jump to /add/:meal. AddFood reads the meal
          // off its route match, so no shared App state is needed.
          .onClick(@router.push, to: "/add/@{item.meal}")
        }
        .tw("px-4 pt-1 pb-5")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-[#F8FAFC]")
    }
  `);
