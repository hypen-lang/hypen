import { app } from "@hypen-space/core";

/**
 * The persistent tab bar — it lives in App's shell, outside the Router, so
 * the same element survives every tab navigation and its selected look can
 * actually travel.
 *
 * The selected pill is a `.states` pose keyed off `@state.location` (App
 * mirrors the router there) rather than a ternary on `.backgroundColor`:
 * the pose glides a soft white pill under one synthesized ease-out, and a
 * non-tab route (`/movie/:id`) matches no label, so every tab falls back to
 * its base look. Taps get press feedback from an `active` opacity variant
 * on the same transition. Icon/label colours stay ternary bindings — they
 * swap with the location write and the pill supplies the motion.
 *
 * Note the poses deliberately avoid `scale`: the DOM renderer's transform
 * applicators append rather than replace, so a repeatedly-written `scale`
 * accumulates and never comes back down. Background-colour replaces cleanly.
 */

const GOLD = "#F5C518";
const MUTED = "#8E8E9A";

function tab(route: string, icon: string, label: string): string {
  return `
      Button {
        Column {
          Icon(@resources.${icon})
            .size(21)
            .color("@{state.location == '${route}' ? '${GOLD}' : '${MUTED}'}")
          Text("${label}")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '${route}' ? '${GOLD}' : '${MUTED}'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-2.5 items-center justify-center")
      .backgroundColor("rgba(255, 255, 255, 0)")
      .cornerRadius(16)
      .opacity({ default: 1, active: 0.55 })
      .transition(240, easeOut)
      .states(@state.location, transition: easeOut, duration: 240) {
        onState("${route}").backgroundColor("rgba(255, 255, 255, 0.07)")
      }
      .onClick(@router.push, to: "${route}")`;
}

export default app
  .defineState({})
  .ui(`
    Row {
${tab("/", "home", "Home")}
${tab("/search", "search", "Search")}
${tab("/watchlist", "bookmark", "Saved")}
${tab("/profile", "user", "Profile")}
    }
    .tw("mx-5 mb-4 px-2 py-1.5 rounded-[24px] border border-white/10 items-center")
    .backgroundColor("rgba(16, 16, 22, 0.88)")
    .backdropFilter("blur(18px)")
    .boxShadow("0 18px 44px rgba(0, 0, 0, 0.5)")
  `);
