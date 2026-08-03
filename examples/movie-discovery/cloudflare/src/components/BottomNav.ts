import { app } from "@hypen-space/core";

/**
 * The persistent tab bar — it lives in App's shell, outside the Router, so
 * the same element survives every tab navigation and its selected look can
 * actually travel.
 *
 * The selected state is a `.states` pose keyed off `@state.location` (App
 * mirrors the router there) rather than a ternary on `.color`: the pose
 * glides the icon/label colour and a soft amber pill on the button together
 * under one synthesized ease-out, and a non-tab route (`/movie/:id`) matches
 * no label, so every tab falls back to its base look. Taps get press
 * feedback from an `active` opacity variant on the same transition.
 *
 * Note the pill/colour poses deliberately avoid `scale`: the DOM renderer's
 * transform applicators append rather than replace, so a repeatedly-written
 * `scale` accumulates (`scale(1) scale(1.25) scale(1)`) and never comes back
 * down. Colour and background-colour replace cleanly.
 */
export default app
  .defineState({})
  .ui(`
    Row {
      Button {
        Column {
          Text("⌂")
            .tw("text-2xl leading-none")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/").color("#FACC15")
            }
          Text("Home")
            .tw("text-xs mt-1")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/").color("#FACC15")
            }
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-3 items-center justify-center")
      .backgroundColor("rgba(250, 204, 21, 0)")
      .cornerRadius(18)
      .opacity({ default: 1, active: 0.5 })
      .transition(240, easeOut)
      .states(@state.location, transition: easeOut, duration: 240) {
        onState("/").backgroundColor("rgba(250, 204, 21, 0.14)")
      }
      .onClick(@router.push, to: "/")

      Button {
        Column {
          Text("⌕")
            .tw("text-2xl leading-none")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/search").color("#FACC15")
            }
          Text("Search")
            .tw("text-xs mt-1")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/search").color("#FACC15")
            }
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-3 items-center justify-center")
      .backgroundColor("rgba(250, 204, 21, 0)")
      .cornerRadius(18)
      .opacity({ default: 1, active: 0.5 })
      .transition(240, easeOut)
      .states(@state.location, transition: easeOut, duration: 240) {
        onState("/search").backgroundColor("rgba(250, 204, 21, 0.14)")
      }
      .onClick(@router.push, to: "/search")

      Button {
        Column {
          Text("＋")
            .tw("text-2xl leading-none")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/watchlist").color("#FACC15")
            }
          Text("Saved")
            .tw("text-xs mt-1")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/watchlist").color("#FACC15")
            }
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-3 items-center justify-center")
      .backgroundColor("rgba(250, 204, 21, 0)")
      .cornerRadius(18)
      .opacity({ default: 1, active: 0.5 })
      .transition(240, easeOut)
      .states(@state.location, transition: easeOut, duration: 240) {
        onState("/watchlist").backgroundColor("rgba(250, 204, 21, 0.14)")
      }
      .onClick(@router.push, to: "/watchlist")

      Button {
        Column {
          Text("◉")
            .tw("text-2xl leading-none")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/profile").color("#FACC15")
            }
          Text("Profile")
            .tw("text-xs mt-1")
            .color("#FBCFE8")
            .states(@state.location, transition: easeOut, duration: 260) {
              onState("/profile").color("#FACC15")
            }
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-3 items-center justify-center")
      .backgroundColor("rgba(250, 204, 21, 0)")
      .cornerRadius(18)
      .opacity({ default: 1, active: 0.5 })
      .transition(240, easeOut)
      .states(@state.location, transition: easeOut, duration: 240) {
        onState("/profile").backgroundColor("rgba(250, 204, 21, 0.14)")
      }
      .onClick(@router.push, to: "/profile")
    }
    .tw("mx-5 mb-4 px-3 py-2 rounded-3xl border-0 items-center")
    .backgroundColor("rgba(18, 8, 15, 0.78)")
    .backdropFilter("blur(18px)")
    .boxShadow("0 18px 54px rgba(0, 0, 0, 0.48)")
  `);
