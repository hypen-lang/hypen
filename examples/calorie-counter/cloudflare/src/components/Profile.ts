import { app } from "@hypen-space/core";
import {
  addDays,
  getDayTotals,
  getPrimaryUser,
  todayStr,
  type User,
} from "../queries";

// Profile — "/profile". Zero shared state; the one user read is a
// direct DB lookup in onActivated.

interface ProfileState {
  user: User;
  streakLabel: string;
  avgCalories: number;
  goals: Array<{ id: string; label: string; value: string }>;
}

// Fallback placeholder so the screen still lays out when the DB is
// empty. When the seed lands, onActivated replaces it.
const BLANK_USER: User = {
  id: "",
  username: "—",
  displayName: "—",
  avatarUrl: "",
  dailyCalorieGoal: 2400,
  carbsGoalG: 224,
  proteinGoalG: 128,
  fatGoalG: 128,
};

function goalsFor(user: User) {
  return [
    { id: "calories", label: "Calories", value: `${user.dailyCalorieGoal} kcal` },
    { id: "carbs",    label: "Carbs",    value: `${user.carbsGoalG} g` },
    { id: "protein",  label: "Protein",  value: `${user.proteinGoalG} g` },
    { id: "fat",      label: "Fat",      value: `${user.fatGoalG} g` },
  ];
}

function refresh(state: ProfileState, user: User) {
  state.user = user;
  state.goals = goalsFor(user);

  // 7-day mini summary: count days with any logged calories.
  const today = todayStr();
  let activeDays = 0;
  let totalCalories = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, -i);
    const t = getDayTotals(user.id, d);
    if (t.calories > 0) activeDays += 1;
    totalCalories += t.calories;
  }
  state.streakLabel = `${activeDays}/7 days logged`;
  state.avgCalories = Math.round(totalCalories / 7);
}

export default app
  .module("Profile")
  .defineState<ProfileState>({
    user: BLANK_USER,
    streakLabel: "0/7 days logged",
    avgCalories: 0,
    goals: goalsFor(BLANK_USER),
  })
  .onActivated(async (state) => {
    const user = getPrimaryUser();
    if (!user) return;
    refresh(state, user);
  })
  .ui(`
    module Profile {
      Column {
        Row {
          Button {
            Icon(@resources.chevron-left)
              .size(19)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 px-3 py-2")
          .opacity({ default: 1, active: 0.6 })
          .transition(150, easeOut)
          .onClick(@router.push, to: "/")

          Text("Profile")
            .tw("flex-1 text-[15px] md:text-base font-semibold")
            .color("#111827")

          Button {
            Icon(@resources.settings)
              .size(19)
              .color("#6B7280")
          }
          .tw("bg-transparent border-0 p-2")
        }
        .tw("px-2 py-2.5 items-center border-b border-gray-100 bg-white")

        Column {
          Image(src: "@{state.user.avatarUrl}")
            .tw("w-20 h-20 md:w-24 md:h-24 rounded-full bg-gray-100 border border-gray-100")
            .objectFit("cover")
          Text("@{state.user.displayName}")
            .tw("text-xl md:text-2xl font-bold mt-3")
            .color("#111827")
          Text("@{state.user.username}")
            .tw("text-sm md:text-base mt-0.5")
            .color("#9CA3AF")
        }
        .tw("py-6 md:py-8 items-center")

        Row {
          Column {
            Text("@{state.avgCalories}")
              .tw("text-xl md:text-2xl font-bold")
              .color("#111827")
            Text("Avg kcal")
              .tw("text-xs md:text-sm mt-0.5")
              .color("#9CA3AF")
          }
          .tw("flex-1 items-center")
          Column {
            Text("@{state.streakLabel}")
              .tw("text-xs md:text-sm text-center")
              .color("#6B7280")
          }
          .tw("flex-1 items-center")
        }
        .tw("mx-4 mb-4 bg-white rounded-2xl p-4 md:p-5 border border-gray-100 items-center")
        .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")

        Text("DAILY GOALS")
          .tw("px-4 pt-4 pb-2 text-[11px] font-semibold tracking-widest")
          .color("#9CA3AF")

        List(@state.goals) {
          Row {
            Text("@{item.label}")
              .tw("flex-1 text-sm md:text-base")
              .color("#111827")
            Text("@{item.value}")
              .tw("text-sm md:text-base font-semibold")
              .color("#EC4899")
          }
          .tw("items-center px-4 py-3 border-b border-gray-100")
        }
        .tw("mx-4 bg-white rounded-2xl border border-gray-100 overflow-hidden")
        .boxShadow("0 1px 3px rgba(17, 24, 39, 0.04)")
      }
      .scrollable(true)
      .tw("flex-1 w-full bg-[#F8FAFC]")
    }
  `);
