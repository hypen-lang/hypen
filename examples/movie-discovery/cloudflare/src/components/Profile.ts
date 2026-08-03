import { app } from "@hypen-space/core";
import { getPrimaryUser, profileStats, type User } from "../queries";

interface StatCard {
  id: string;
  label: string;
  value: string;
  tint: string;
}

interface ProfileState {
  user: User;
  stats: StatCard[];
}

const EMPTY_USER: User = {
  id: "",
  name: "",
  handle: "",
  avatar: "",
  favoriteGenre: "",
};

async function refresh(state: ProfileState) {
  const user = getPrimaryUser();
  const stats = await profileStats(user.id);
  state.user = user;
  state.stats = [
    { id: "saved", label: "Saved", value: String(stats.saved), tint: "#F5C518" },
    { id: "genre", label: "Top genre", value: stats.topGenre, tint: "#F8FAFC" },
    { id: "hours", label: "Queued", value: `${stats.hoursQueued}h`, tint: "#F8FAFC" },
  ];
}

export default app
  .module("Profile")
  .defineState<ProfileState>({
    user: EMPTY_USER,
    stats: [],
  })
  .onActivated(async (state) => refresh(state))
  .ui(`
    module Profile {
      Column {
        Text("Profile")
          .tw("px-5 pt-6 text-2xl md:text-3xl font-bold tracking-tight")
          .color("#F8FAFC")

        Column {
          Column {
            Text("@{state.user.avatar}")
              .tw("text-2xl font-bold")
              .color("#0B0B10")
          }
          .tw("w-20 h-20 rounded-full items-center justify-center")
          .linearGradient("135deg, #F5C518 0%, #E8A317 100%")

          Text("@{state.user.name}")
            .tw("text-xl md:text-2xl font-bold mt-4")
            .color("#F8FAFC")
          Text("@{state.user.handle}")
            .tw("text-[13px] mt-0.5")
            .color("#8E8E9A")
          Text("Favorite genre · @{state.user.favoriteGenre}")
            .tw("text-xs font-medium mt-4 px-3.5 py-1.5 rounded-full border border-white/10")
            .backgroundColor("rgba(255, 255, 255, 0.06)")
            .color("#C6C6D0")
        }
        .tw("mx-5 mt-5 p-7 rounded-3xl border border-white/10 items-center")
        .backgroundColor("rgba(255, 255, 255, 0.04)")

        Text("Library pulse")
          .tw("px-5 pt-7 pb-3 text-lg md:text-xl font-bold")
          .color("#F8FAFC")

        Grid(@state.stats, key: "id") {
          Column {
            Text("@{item.value}")
              .tw("text-2xl md:text-3xl font-bold text-center")
              .color("@{item.tint}")
            Text("@{item.label}")
              .tw("text-xs mt-1.5 text-center font-medium")
              .color("#8E8E9A")
          }
          .tw("p-5 rounded-2xl border border-white/10 items-center justify-center")
          .backgroundColor("rgba(255, 255, 255, 0.04)")
          .enter(slide, fade, from: bottom, duration: 320)
        }
        .gridColumns(3)
        .gap(12)
        .tw("px-5")

        Column {
          Text("Demo notes")
            .tw("text-[15px] font-semibold")
            .color("#F8FAFC")
          Text("This example focuses on rich catalog browsing, detail routes, search filters, and persistent watchlist state.")
            .tw("text-[13px] mt-2 leading-6")
            .color("#8E8E9A")
        }
        .tw("mx-5 mt-6 p-5 rounded-2xl border border-white/10")
        .backgroundColor("rgba(255, 255, 255, 0.04)")
      }
      .scrollable(true)
      .tw("flex-1")
      .backgroundColor("#0B0B10")
    }
  `);
