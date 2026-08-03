import { app } from "@hypen-space/core";
import {
  addDays,
  getDaySummary,
  getPrimaryUser,
  getWeekSummary,
  startOfWeek,
  shortDay,
  todayStr,
  type WeekSummary,
  type User,
} from "../queries";

// Stats — "/stats". Daily vs. weekly toggle + period navigation stay
// local to this screen (they're a UI affordance that doesn't affect
// anything else). User read comes straight from the DB on activate,
// so there's zero cross-module state involved.

type Mode = "daily" | "weekly";

interface WeekBarView {
  id: string;
  date: string;
  shortLabel: string;
  caloriesEaten: number;
  barHeight: string;
  valueLabel: string;
  isActive: boolean;
  valueColor: string;
}

interface MacroRowView {
  label: string;
  carbsWidth: string;
  proteinWidth: string;
  fatWidth: string;
  carbsLabel: string;
  proteinLabel: string;
  fatLabel: string;
}

interface StatsState {
  mode: Mode;
  modes: Array<{ id: Mode; label: string; active: boolean }>;
  anchor: string;       // any date inside the active week / the selected day
  rangeLabel: string;
  bars: WeekBarView[];
  goalLineHeight: string;
  primary: MacroRowView;
  goal: MacroRowView;
  showGoalRow: boolean;
}

const MODE_TABS: Array<{ id: Mode; label: string }> = [
  { id: "daily",  label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

function emptyRow(label: string): MacroRowView {
  return {
    label,
    carbsWidth: "0%",
    proteinWidth: "0%",
    fatWidth: "0%",
    carbsLabel: "0%",
    proteinLabel: "0%",
    fatLabel: "0%",
  };
}

function refreshModeTabs(state: StatsState) {
  state.modes = MODE_TABS.map((t) => ({ ...t, active: t.id === state.mode }));
}

function buildWeeklyView(state: StatsState, user: User, week: WeekSummary, today: string) {
  // Scale against the goal as well as the biggest day (plus 8% headroom) so
  // the dashed goal line sits inside the chart instead of pinned to its top
  // edge on weeks where nobody hit the goal.
  const maxEaten = Math.max(1, week.calorieGoal, ...week.days.map((d) => d.caloriesEaten)) * 1.08;
  state.bars = week.days.map((d) => {
    const pct = Math.round((d.caloriesEaten / maxEaten) * 100);
    // Pin empty days at a small visible height so the chart still
    // reads as a proper 7-bar Mon-Sun strip on a sparse week.
    const height = d.caloriesEaten > 0 ? `${pct}%` : "4px";
    return {
      id: d.date,
      date: d.date,
      shortLabel: d.shortLabel,
      caloriesEaten: d.caloriesEaten,
      barHeight: height,
      valueLabel: d.caloriesEaten > 0 ? String(d.caloriesEaten) : "",
      isActive: d.date === today,
      valueColor: d.date === today ? "#EC4899" : "#9CA3AF",
    };
  });

  const goalPct = Math.min(100, Math.round((week.calorieGoal / maxEaten) * 100));
  state.goalLineHeight = `${goalPct}%`;
  state.rangeLabel = week.rangeLabel;

  state.primary = {
    label: "Average",
    carbsWidth: `${week.avgCarbsPct}%`,
    proteinWidth: `${week.avgProteinPct}%`,
    fatWidth: `${week.avgFatPct}%`,
    carbsLabel: `${week.avgCarbsPct}%`,
    proteinLabel: `${week.avgProteinPct}%`,
    fatLabel: `${week.avgFatPct}%`,
  };
  state.goal = {
    label: "Goal",
    carbsWidth: `${week.goalCarbsPct}%`,
    proteinWidth: `${week.goalProteinPct}%`,
    fatWidth: `${week.goalFatPct}%`,
    carbsLabel: `${week.goalCarbsPct}%`,
    proteinLabel: `${week.goalProteinPct}%`,
    fatLabel: `${week.goalFatPct}%`,
  };
  state.showGoalRow = true;
}

function buildDailyView(state: StatsState, user: User, date: string) {
  const summary = getDaySummary(user, date);
  const maxEaten = Math.max(1, summary.calorieGoal, summary.caloriesEaten) * 1.08;
  const pct = Math.round((summary.caloriesEaten / maxEaten) * 100);
  state.bars = [
    {
      id: date,
      date,
      shortLabel: shortDay(date),
      caloriesEaten: summary.caloriesEaten,
      barHeight: summary.caloriesEaten > 0 ? `${pct}%` : "4px",
      valueLabel: summary.caloriesEaten > 0 ? String(summary.caloriesEaten) : "0",
      isActive: true,
      valueColor: "#EC4899",
    },
  ];

  const goalPct = Math.round((summary.calorieGoal / maxEaten) * 100);
  state.goalLineHeight = `${goalPct}%`;
  state.rangeLabel = summary.label;

  // Per-day macro kcal breakdown.
  const kcalC = summary.carbsG * 4;
  const kcalP = summary.proteinG * 4;
  const kcalF = summary.fatG * 9;
  const total = Math.max(1, kcalC + kcalP + kcalF);
  const cPct = Math.round((kcalC / total) * 100);
  const pPct = Math.round((kcalP / total) * 100);
  const fPct = Math.max(0, 100 - cPct - pPct);

  state.primary = {
    label: "Today",
    carbsWidth: `${cPct}%`,
    proteinWidth: `${pPct}%`,
    fatWidth: `${fPct}%`,
    carbsLabel: `${cPct}%`,
    proteinLabel: `${pPct}%`,
    fatLabel: `${fPct}%`,
  };
  state.goal = emptyRow("Goal");
  state.showGoalRow = false;
}

function rebuildFor(state: StatsState, user: User) {
  refreshModeTabs(state);
  if (state.mode === "weekly") {
    buildWeeklyView(state, user, getWeekSummary(user, state.anchor), todayStr());
  } else {
    buildDailyView(state, user, state.anchor);
  }
}

export default app
  .module("Stats")
  .defineState<StatsState>({
    mode: "weekly",
    modes: MODE_TABS.map((t) => ({ ...t, active: t.id === "weekly" })),
    anchor: todayStr(),
    rangeLabel: "This week",
    bars: [],
    goalLineHeight: "75%",
    primary: emptyRow("Average"),
    goal: emptyRow("Goal"),
    showGoalRow: true,
  })
  .onActivated(async (state) => {
    const user = getPrimaryUser();
    if (!user) return;
    state.anchor = state.anchor || todayStr();
    rebuildFor(state, user);
  })
  .onAction<{ mode: Mode }>("selectMode", async ({ state, action }) => {
    const user = getPrimaryUser();
    if (!user || !action.payload) return;
    state.mode = action.payload.mode;
    if (state.mode === "daily") state.anchor = todayStr();
    rebuildFor(state, user);
  })
  .onAction<{ direction: "prev" | "next" }>("shiftPeriod", async ({ state, action }) => {
    const user = getPrimaryUser();
    if (!user || !action.payload) return;
    const delta = action.payload.direction === "next" ? 1 : -1;
    if (state.mode === "weekly") {
      state.anchor = addDays(startOfWeek(state.anchor), delta * 7);
    } else {
      state.anchor = addDays(state.anchor, delta);
    }
    rebuildFor(state, user);
  })
  .ui(`
    module Stats {
      Column {
        // ----- Top bar -----
        Row {
          Button {
            Icon(@resources.chevron-left)
              .size(19)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 p-2")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@router.push, to: "/")

          Text("Nutrition")
            .tw("flex-1 text-[15px] md:text-base font-semibold ml-1")
            .color("#111827")

          List(@state.modes) {
            Button {
              Text("@{item.label}")
                .tw("text-xs md:text-sm font-semibold")
                .color("@{item.active ? '#FFFFFF' : '#6B7280'}")
            }
            .tw("px-3.5 py-1.5 rounded-full border-0")
            .backgroundColor("@{item.active ? '#EC4899' : 'transparent'}")
            .transition(220, easeOut, props: [backgroundColor])
            .onClick(@actions.selectMode, mode: "@{item.id}")
          }
          .tw("flex flex-row bg-gray-100 rounded-full p-1")
        }
        .tw("px-3 py-2.5 items-center border-b border-gray-100 bg-white")

        // ----- Period navigator -----
        Row {
          Button {
            Icon(@resources.chevron-left)
              .size(17)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 px-3.5 py-2.5")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.shiftPeriod, direction: "prev")

          Text("@{state.rangeLabel}")
            .tw("flex-1 text-center text-sm md:text-base font-semibold")
            .color("#111827")

          Button {
            Icon(@resources.chevron-right)
              .size(17)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 px-3.5 py-2.5")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@actions.shiftPeriod, direction: "next")
        }
        .tw("mx-4 my-3 bg-white border border-gray-100 rounded-2xl items-center")
        .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")

        // ----- Calorie bar chart -----
        Text("CALORIES (KCAL)")
          .tw("px-4 pt-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        Row {
          Row {
            Box {}
              .tw("w-2 h-2 rounded-full bg-pink-500 mr-1")
            Text("Consumed")
              .tw("text-xs md:text-sm")
              .color("#6B7280")
          }
          .tw("items-center mr-4")
          Row {
            Box {}
              .tw("w-2 h-2 rounded-full bg-amber-400 mr-1")
            Text("Goal")
              .tw("text-xs md:text-sm")
              .color("#6B7280")
          }
          .tw("items-center")
        }
        .tw("px-4 py-2 items-center")

        Box {
          Box {}
            .tw("absolute left-2 right-2 border-t-2 border-dashed border-amber-400 opacity-70")
            .bottom("@{state.goalLineHeight}")

          List(@state.bars) {
            Column {
              Text("@{item.valueLabel}")
                .tw("text-xs md:text-sm font-semibold mb-1")
                .color("@{item.valueColor}")

              // Bar well — takes the remaining vertical space between
              // the value label and the day label. The bar pins to its
              // bottom (justify-end), and the bar's percentage height
              // resolves against *this* well (which has a defined size
              // via flex-1 inside the h-full column) instead of the
              // column's natural content height.
              Column {
                Box {}
                  .tw("w-6 md:w-8 rounded-t-md")
                  .backgroundColor("@{item.isActive ? '#EC4899' : '#FBCFE8'}")
                  .height("@{item.barHeight}")
                  .transition(500, easeOut, props: [height])
              }
              .tw("flex-1 w-full justify-end items-center")

              Text("@{item.shortLabel}")
                .tw("text-xs md:text-sm mt-2")
                .color("#6B7280")
            }
            .tw("flex-1 h-full items-center")
          }
          .tw("flex flex-row h-full items-stretch")
        }
        .tw("mx-4 h-56 md:h-72 bg-white border border-gray-100 rounded-2xl p-3 md:p-4 relative")
        .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")

        // ----- Nutrition % section -----
        Text("NUTRITION (%)")
          .tw("px-4 pt-5 pb-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        Row {
          Row {
            Box {}.tw("w-2 h-2 rounded-full bg-pink-500 mr-1")
            Text("Carbs")
              .tw("text-xs md:text-sm mr-3")
              .color("#6B7280")
          }.tw("items-center")
          Row {
            Box {}.tw("w-2 h-2 rounded-full bg-amber-400 mr-1")
            Text("Protein")
              .tw("text-xs md:text-sm mr-3")
              .color("#6B7280")
          }.tw("items-center")
          Row {
            Box {}.tw("w-2 h-2 rounded-full bg-violet-400 mr-1")
            Text("Fat")
              .tw("text-xs md:text-sm")
              .color("#6B7280")
          }.tw("items-center")
        }
        .tw("px-4 pb-2 items-center")

        Column {
          Row {
            Text("@{state.primary.label}")
              .tw("w-20 md:w-24 text-sm md:text-base font-medium")
              .color("#374151")
            Row {
              Box {}
                .tw("h-6 md:h-8 bg-pink-500")
                .width("@{state.primary.carbsWidth}")
                .transition(450, easeOut, props: [width])
              Box {}
                .tw("h-6 md:h-8 bg-amber-400")
                .width("@{state.primary.proteinWidth}")
                .transition(450, easeOut, props: [width])
              Box {}
                .tw("h-6 md:h-8 bg-violet-400")
                .width("@{state.primary.fatWidth}")
                .transition(450, easeOut, props: [width])
            }
            .tw("flex-1 rounded-full overflow-hidden")
          }
          .tw("items-center mb-2")

          If(condition: @state.showGoalRow) {
            Row {
              Text("@{state.goal.label}")
                .tw("w-20 md:w-24 text-sm md:text-base font-medium")
                .color("#374151")
              Row {
                Box {}
                  .tw("h-6 md:h-8 bg-pink-500")
                  .width("@{state.goal.carbsWidth}")
                Box {}
                  .tw("h-6 md:h-8 bg-amber-400")
                  .width("@{state.goal.proteinWidth}")
                Box {}
                  .tw("h-6 md:h-8 bg-violet-400")
                  .width("@{state.goal.fatWidth}")
              }
              .tw("flex-1 rounded-full overflow-hidden")
            }
            .tw("items-center")
          }
        }
        .tw("mx-4 mb-4 bg-white rounded-2xl p-4 md:p-5 border border-gray-100")
        .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-[#F8FAFC]")
    }
  `);
