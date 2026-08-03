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
          Icon(@resources.home)
            .size(21)
            .color("@{state.location == '/' ? '#EC4899' : '#9CA3AF'}")
          Text("Home")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '/' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/")

      Button {
        Column {
          Icon(@resources.book)
            .size(21)
            .color("@{state.location == '/diary' ? '#EC4899' : '#9CA3AF'}")
          Text("Diary")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '/diary' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/diary")

      Button {
        Icon(@resources.plus)
          .size(24)
          .color("#ffffff")
      }
      .tw("bg-pink-500 border-0 w-14 h-14 md:w-16 md:h-16 rounded-full items-center justify-center -mt-5")
      .boxShadow("0 10px 24px rgba(236, 72, 153, 0.35)")
      .opacity({ default: 1, active: 0.75 })
      .transition(150, easeOut)
      .onClick(@router.push, to: "/add/breakfast")

      Button {
        Column {
          Icon(@resources.chart)
            .size(21)
            .color("@{state.location == '/stats' ? '#EC4899' : '#9CA3AF'}")
          Text("Stats")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '/stats' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/stats")

      Button {
        Column {
          Icon(@resources.user)
            .size(21)
            .color("@{state.location == '/profile' ? '#EC4899' : '#9CA3AF'}")
          Text("Profile")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '/profile' ? '#EC4899' : '#9CA3AF'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 bg-transparent border-0 py-2 items-center justify-center")
      .onClick(@router.push, to: "/profile")
    }
    .tw("px-3 pt-1.5 pb-5 md:pb-6 bg-white border-t border-gray-100 items-center justify-around")
  `);
