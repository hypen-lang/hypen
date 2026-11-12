import { app } from "@hypen-space/core";
import { ACCENT, MUTED } from "../theme";

// The persistent tab bar. Anonymous (`app.defineState({})`, no `.module()`),
// so `@state.location` falls through to App's scope; it is handed to the DO
// through `componentTemplates` in worker.ts. The selected pill is a `.states`
// pose keyed off the location, so it glides instead of snapping.

function tab(route: string, icon: string, label: string): string {
  return `
      Button {
        Column {
          Icon(@resources.${icon})
            .size(20)
            .color("@{state.location == '${route}' ? '${ACCENT}' : '${MUTED}'}")
          Text("${label}")
            .tw("text-[11px] font-medium mt-1")
            .color("@{state.location == '${route}' ? '${ACCENT}' : '${MUTED}'}")
        }
        .tw("items-center")
      }
      .tw("flex-1 border-0 py-2 items-center justify-center")
      .backgroundColor("rgba(255, 255, 255, 0)")
      .cornerRadius(16)
      .opacity({ default: 1, active: 0.55 })
      .transition(220, easeOut)
      .states(@state.location, transition: easeOut, duration: 220) {
        onState("${route}").backgroundColor("rgba(255, 122, 26, 0.10)")
      }
      .onClick(@router.push, to: "${route}")`;
}

export default app
  .defineState({})
  .ui(`
    Row {
${tab("/", "sun", "Today")}
${tab("/hn", "zap", "Hacker News")}
${tab("/onthisday", "calendar", "On this day")}
${tab("/saved", "bookmark", "Saved")}
    }
    .tw("mb-3 px-1.5 py-1.5 rounded-[22px] border border-white/10 items-center")
    .maxWidth(520)
    .width("calc(100% - 32px)")
    .alignSelf("center")
    .backgroundColor("rgba(22, 22, 27, 0.92)")
    .backdropFilter("blur(18px)")
    .boxShadow("0 14px 40px rgba(0, 0, 0, 0.5)")
  `);
