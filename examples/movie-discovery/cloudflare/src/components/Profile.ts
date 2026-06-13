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
    { id: "saved", label: "Saved", value: String(stats.saved), tint: "#FACC15" },
    { id: "genre", label: "Top genre", value: stats.topGenre, tint: "#EC4899" },
    { id: "hours", label: "Queued", value: `${stats.hoursQueued}h`, tint: "#F9A8D4" },
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
          .tw("px-5 pt-6 text-3xl md:text-4xl font-black")
          .color("#F8FAFC")

        Column {
          Column {
            Text("@{state.user.avatar}")
              .tw("text-3xl font-black")
              .color("#0F172A")
          }
          .tw("w-24 h-24 rounded-full items-center justify-center")
          .linearGradient("135deg, #EC4899 0%, #F472B6 100%")
          .boxShadow("0 18px 42px rgba(236, 72, 153, 0.34)")

          Text("@{state.user.name}")
            .tw("text-2xl md:text-3xl font-black mt-4")
            .color("#F8FAFC")
          Text("@{state.user.handle}")
            .tw("text-sm mt-1")
            .color("#FBCFE8")
          Text("Favorite genre: @{state.user.favoriteGenre}")
            .tw("text-sm font-bold mt-4 px-4 py-2 rounded-full")
            .backgroundColor("rgba(255, 255, 255, 0.12)")
            .color("#FFEDD5")
        }
        .tw("mx-5 mt-5 p-7 rounded-3xl border-0 items-center")
        .linearGradient("135deg, rgba(236, 72, 153, 0.40) 0%, rgba(10, 10, 12, 0.96) 50%, rgba(244, 114, 182, 0.18) 100%")
        .boxShadow("0 24px 60px rgba(236, 72, 153, 0.20)")

        Text("Library pulse")
          .tw("px-5 pt-7 pb-3 text-2xl md:text-3xl font-black")
          .color("#F8FAFC")

        Grid(@state.stats, key: "id") {
          Column {
            Text("@{item.value}")
              .tw("text-3xl md:text-4xl font-black text-center")
              .color("@{item.tint}")
            Text("@{item.label}")
              .tw("text-xs md:text-sm mt-2 text-center font-bold")
              .color("#FBCFE8")
          }
          .tw("p-5 rounded-3xl border-0 items-center")
          .linearGradient("180deg, rgba(255, 255, 255, 0.13) 0%, rgba(255, 255, 255, 0.055) 100%")
          .boxShadow("0 18px 42px rgba(2, 6, 23, 0.35)")
        }
        .gridColumns(3)
        .gap(12)
        .tw("px-5")

        Column {
          Text("Demo notes")
            .tw("text-lg font-bold")
            .color("#F8FAFC")
          Text("This example focuses on rich catalog browsing, detail routes, search filters, and persistent watchlist state.")
            .tw("text-sm mt-2 leading-6")
            .color("#FBCFE8")
        }
        .tw("mx-5 mt-6 p-5 rounded-3xl border-0")
        .backgroundColor("rgba(255, 255, 255, 0.10)")
        .boxShadow("0 18px 42px rgba(2, 6, 23, 0.35)")
      }
      .scrollable(true)
      .tw("flex-1")
      .linearGradient("180deg, #050505 0%, #190812 54%, #050505 100%")
    }
  `);
