// Shared DSL fragments. Screens are separate modules, so a reusable row is a
// string spliced into each template (a custom `component` would dispatch its
// `@actions` against the wrong scope); every screen module implements the
// `play` and `openStation` actions these fragments call.

export const C = {
  bg: "#0D0E17",
  surface: "#161827",
  surface2: "#1F2235",
  line: "rgba(255, 255, 255, 0.08)",
  text: "#F4F5FA",
  muted: "#9095AD",
  faint: "#5C6079",
  accent: "#FF5A36",
  accentSoft: "rgba(255, 90, 54, 0.14)",
};

/** Square station artwork (worker-served, always an image — see /art). */
export const art = (src: string, size: number, radius: number, alt: string) => `
          Image(src: "${src}", alt: "${alt}")
            .objectFit("cover")
            .width(${size})
            .height(${size})
            .minWidth(${size})
            .borderRadius(${radius})
            .backgroundColor("${C.surface2}")`;

/** Keyed list of station rows bound to `@state.<binding>`. */
export const stationRows = (binding: string) => `
        ForEach(items: @state.${binding}, key: "id") {
          Row {
            Button {
              Row {
${art("@{item.art}", 48, 10, "@{item.name} logo")}
                Column {
                  Text("@{item.name}")
                    .tw("text-[15px] font-semibold text-left")
                    .color("${C.text}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("@{item.subtitle}")
                    .tw("text-xs mt-0.5 text-left")
                    .color("${C.muted}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("@{item.quality}")
                    .tw("text-[11px] mt-0.5 text-left")
                    .color("${C.faint}")
                }
                .tw("flex-1 min-w-0 ml-3 items-start")
              }
              .tw("items-center w-full")
            }
            .tw("flex-1 min-w-0 bg-transparent border-0 p-0 items-stretch")
            .opacity({ default: 1, active: 0.6 })
            .transition(140, easeOut)
            .onClick(@actions.openStation, id: "@{item.id}")

            Button {
              Icon(@resources.play)
                .size(16)
                .color("${C.text}")
            }
            .tw("w-10 h-10 ml-3 rounded-full border-0 items-center justify-center shrink-0")
            .backgroundColor({ default: "${C.surface2}", hover: "${C.accent}" })
            .opacity({ default: 1, active: 0.6 })
            .transition(140, easeOut)
            .onClick(@actions.play, id: "@{item.id}")
            .label("Play station")
          }
          .tw("items-center py-2.5")
          .borderBottom("1px solid ${C.line}")
          .enter(fade, duration: 200)
        }`;

/** Back button + title header for sub-screens. */
export const subHeader = (title: string, subtitle = "") => `
        Row {
          Button {
            Icon(@resources.chevron-left)
              .size(20)
              .color("${C.text}")
          }
          .tw("w-10 h-10 rounded-full border-0 items-center justify-center shrink-0")
          .backgroundColor("${C.surface}")
          .opacity({ default: 1, active: 0.6 })
          .onClick(@actions.back)
          .label("Back")
          Column {
            Heading("${title}", level: 1)
              .tw("text-xl font-bold text-left")
              .color("${C.text}")
              .maxLines(1)
              .textOverflow("ellipsis")
            ${subtitle ? `Text("${subtitle}")
              .tw("text-xs mt-0.5 text-left")
              .color("${C.muted}")` : ""}
          }
          .tw("flex-1 min-w-0 ml-3 items-start")
        }
        .tw("items-center pt-5 pb-3")`;

/** Shimmer placeholder rows while a list loads. */
export const skeletonRows = (n: number) =>
  Array.from({ length: n }, () => `
          Row {
            Box {}.tw("w-12 h-12 rounded-[10px]").backgroundColor("${C.surface}")
            Column {
              Box {}.tw("h-3 w-40 rounded").backgroundColor("${C.surface}")
              Box {}.tw("h-2.5 w-24 mt-2 rounded").backgroundColor("${C.surface}")
            }
            .tw("ml-3 items-start")
          }
          .tw("items-center py-2.5")
          .animate(shimmer)`).join("");

/** Error card with retry. */
export const errorCard = (messageBinding: string) => `
          Column {
            Icon(@resources.alert)
              .size(26)
              .color("${C.accent}")
            Text("${messageBinding}")
              .tw("text-sm mt-3 text-center")
              .color("${C.muted}")
            Button {
              Text("Try again")
                .tw("text-sm font-semibold")
                .color("${C.text}")
            }
            .tw("mt-4 h-10 px-5 rounded-xl border-0 items-center justify-center")
            .backgroundColor("${C.surface2}")
            .onClick(@actions.retry)
          }
          .tw("items-center py-10 px-6 mt-4 rounded-2xl")
          .backgroundColor("${C.surface}")`;

/** Screen scroll container wrapper. */
export const screen = (name: string, body: string) => `
    module ${name} {
      Column {
        Column {
${body}
        }
        .tw("w-full px-4 pb-6")
        .maxWidth(720)
      }
      .horizontalAlignment("center")
      .scrollable(true)
      .tw("flex-1 w-full min-h-0")
      .backgroundColor("${C.bg}")
    }`;
