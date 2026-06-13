import { app } from "@hypen-space/core";

export default app
  .defineState({})
  .ui(`
    Row {
      Button {
        Column {
          Text("⌂")
            .tw("text-2xl leading-none")
            .color("@{state.location == '/' ? '#FACC15' : '#FBCFE8'}")
          Text("Home")
            .tw("text-xs mt-1")
            .color("@{state.location == '/' ? '#FACC15' : '#FBCFE8'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-3 items-center justify-center")
      .onClick(@router.push, to: "/")

      Button {
        Column {
          Text("⌕")
            .tw("text-2xl leading-none")
            .color("@{state.location == '/search' ? '#FACC15' : '#FBCFE8'}")
          Text("Search")
            .tw("text-xs mt-1")
            .color("@{state.location == '/search' ? '#FACC15' : '#FBCFE8'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-3 items-center justify-center")
      .onClick(@router.push, to: "/search")

      Button {
        Column {
          Text("＋")
            .tw("text-2xl leading-none")
            .color("@{state.location == '/watchlist' ? '#FACC15' : '#FBCFE8'}")
          Text("Saved")
            .tw("text-xs mt-1")
            .color("@{state.location == '/watchlist' ? '#FACC15' : '#FBCFE8'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-3 items-center justify-center")
      .onClick(@router.push, to: "/watchlist")

      Button {
        Column {
          Text("◉")
            .tw("text-2xl leading-none")
            .color("@{state.location == '/profile' ? '#FACC15' : '#FBCFE8'}")
          Text("Profile")
            .tw("text-xs mt-1")
            .color("@{state.location == '/profile' ? '#FACC15' : '#FBCFE8'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-3 items-center justify-center")
      .onClick(@router.push, to: "/profile")
    }
    .tw("mx-5 mb-4 px-3 py-2 rounded-3xl border-0 items-center")
    .backgroundColor("rgba(18, 8, 15, 0.78)")
    .backdropFilter("blur(18px)")
    .boxShadow("0 18px 54px rgba(0, 0, 0, 0.48)")
  `);
