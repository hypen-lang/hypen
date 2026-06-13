import { app } from "@hypen-space/core";

// BottomNav — stateless. We deliberately skip `app.module("BottomNav")`
// so the definition does *not* auto-register in the HypenApp registry,
// which means `RemoteSession.registerNestedModules` never claims a
// state scope for it. Discovery still picks the file up (by filename)
// and stuffs the template into the component resolver, so the Router
// can resolve `BottomNav()`. With no nested scope, the template's
// `@state.location` binding falls through to the primary App module's
// state — which is exactly the active-tab highlight we want.
//
// Tapping "+" goes to /add/breakfast as a sensible default; logs from
// Home's meal cards push specific meals.

export default app
  .defineState({})
  .ui(`
    Row {
      Button {
        Column {
          Text("🏠")
            .tw("text-xl md:text-2xl leading-none")
          Text("Home")
            .tw("text-xs md:text-sm mt-1")
            .color("@{state.location == '/' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/")

      Button {
        Column {
          Text("📓")
            .tw("text-xl md:text-2xl leading-none")
          Text("Diary")
            .tw("text-xs md:text-sm mt-1")
            .color("#9CA3AF")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/diary")

      Button {
        Text("+")
          .tw("text-white text-2xl md:text-3xl font-bold leading-none")
      }
      .tw("bg-pink-500 border-0 w-14 h-14 md:w-16 md:h-16 rounded-full shadow-lg items-center justify-center -mt-4")
      .onClick(@router.push, to: "/add/breakfast")

      Button {
        Column {
          Text("📊")
            .tw("text-xl md:text-2xl leading-none")
          Text("Stats")
            .tw("text-xs md:text-sm mt-1")
            .color("@{state.location == '/stats' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/stats")

      Button {
        Column {
          Text("👤")
            .tw("text-xl md:text-2xl leading-none")
          Text("Profile")
            .tw("text-xs md:text-sm mt-1")
            .color("@{state.location == '/profile' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/profile")
    }
    .tw("px-3 pt-1 pb-5 md:pb-6 bg-white border-t border-gray-200 items-center justify-around")
  `);
