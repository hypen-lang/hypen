// Shared DSL fragments and the design tokens.
//
// Screens are separate modules, so a reusable row is a string spliced into
// each template (a custom `component` would dispatch its `@actions` against
// the wrong scope); every screen module implements the `play` and
// `openStation` actions these fragments call.
//
// The look: a studio at night. Warm near-black, cream type, and one signal
// red that is reserved for "on air" (the live dot, the stop button, the dial
// needle). Headlines are heavy and tight; technical facts (codec, bitrate,
// ranks) are set in a monospace face like a tuner readout. An FM dial scale
// recurs as the house rule. Colour otherwise comes from the stations: each
// has its own tint (tint.ts), shared with its generated artwork.
//
// Renderer notes: the desktop renderer has one sans face and no letter
// spacing, text-transform, flex-wrap or blur, so capitals are typed as
// capitals, chips sit in scrolling rows or grids, and nothing depends on a
// font family to hold the layout together.

export const C = {
  bg: "#0D0B09",
  surface: "#17140F",
  raised: "#221E17",
  line: "rgba(244, 238, 225, 0.10)",
  lineStrong: "rgba(244, 238, 225, 0.22)",
  text: "#F4EEE1",
  muted: "#B0A898",
  faint: "#8C8474",
  /** On-air red. Text on it is `ink`, never white (white is 3.3:1). */
  accent: "#FF5126",
  accentSoft: "rgba(255, 81, 38, 0.14)",
  ink: "#0D0B09",
};

export const SANS =
  "'Inter Display', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";
const MONO_STACK = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
/** Applicator: tuner-readout face for technical labels. */
export const MONO = `.fontFamily("${MONO_STACK}")`;

/** Small all-caps monospace label (typed in capitals: see renderer notes). */
export const kicker = (text: string, color = C.accent, extra = "") => `
              Text("${text}")
                .tw("text-[11px] font-bold tracking-widest text-left ${extra}")
                ${MONO}
                .color("${color}")`;

/** Square station artwork (worker-served, always an image — see /art). */
export const art = (src: string, size: number, radius: number, alt: string) => `
          Image(src: "${src}", alt: "${alt}")
            .objectFit("cover")
            .width(${size})
            .height(${size})
            .minWidth(${size})
            .borderRadius(${radius})
            .backgroundColor("${C.raised}")`;

/**
 * FM dial scale: tick marks with a red needle. Decorative (hidden from
 * assistive tech); `needle` is the tick index the needle replaces.
 */
export const dial = (ticks = 45, needle = 28, withNumbers = true) => `
          Column {
            Row {
${Array.from({ length: ticks }, (_, i) =>
  i === needle
    ? `              Box {}.width(3).height(22).borderRadius(2).backgroundColor("${C.accent}")`
    : `              Box {}.width(${i % 4 === 0 ? 2 : 1}).height(${i % 4 === 0 ? 12 : 6}).backgroundColor("${i % 4 === 0 ? C.lineStrong : C.line}")`,
).join("\n")}
            }
            .tw("w-full items-end justify-between h-[22px]")
            ${withNumbers ? `Row {
${["88", "92", "96", "100", "104", "108"].map((n) => `              Text("${n}").tw("text-[10px]").color("${C.faint}")${MONO}`).join("\n")}
            }
            .tw("w-full justify-between mt-1.5")` : ""}
          }
          .tw("w-full")
          .hidden()`;

/**
 * Level-meter bars. Each bar pulses on its own clock, so the group reads as
 * a moving meter; a renderer that snaps animations shows a static meter.
 */
export const eqBars = (height: number, color = C.accent) => {
  const bars = [
    [0.45, 900],
    [1, 620],
    [0.65, 1100],
    [0.85, 760],
  ];
  return `
              Row {
${bars.map(([h, ms]) => `                Box {}.width(3).height(${Math.round(height * h)}).borderRadius(2).backgroundColor("${color}").animate(pulse, duration: ${ms})`).join("\n")}
              }
              .tw("items-end shrink-0")
              .gap(2)
              .height(${height})
              .hidden()`;
};

/** The round play button: solid cream over artwork, a quiet ring (ghost) in rows. */
const playButton = (size: number, extra = "", ghost = false) => `
            Button {
              Icon(@resources.play)
                .size(${Math.round(size * 0.4)})
                .color("${ghost ? C.text : C.ink}")
            }
            .tw("rounded-full items-center justify-center shrink-0 p-0 ${extra}")
            .width(${size})
            .height(${size})
            .border("1px solid ${ghost ? C.lineStrong : C.text}")
            .backgroundColor(${ghost ? `{ default: "rgba(244, 238, 225, 0.04)", hover: "rgba(244, 238, 225, 0.18)" }` : `{ default: "${C.text}", hover: "#FFFFFF" }`})
            .opacity({ default: 1, active: 0.72 })
            .transition(140, easeOut)
            .onClick(@actions.play, id: "@{item.id}")
            .label("Play station")`;

/**
 * Keyed list of station rows bound to `@state.<binding>`: one column on a
 * phone, two from the md breakpoint. `ranked` shows `item.rank` ("01"…) as a
 * chart position.
 *
 * "when" gates the whole list on a state expression. Screens whose list can
 * become empty pass one: with the published SDK, assigning [] to a list
 * that had rows leaves the old rows on screen, so an emptied list is
 * unmounted instead of being diffed down to nothing.
 */
export const stationRows = (binding: string, ranked = false, when = "") => `
        ${when ? `If(condition: "@{${when}}") {` : ""}
        Grid(@state.${binding}, key: "id") {
          Row {
            ${ranked ? `Text("@{item.rank}")
              .tw("text-[13px] font-bold text-left")
              .width(32)
              .minWidth(32)
              ${MONO}
              .color("${C.faint}")` : ""}
            Button {
              Row {
${art("@{item.art}", 56, 14, "@{item.name} logo")}
                Column {
                  Text("@{item.name}")
                    .tw("text-base font-bold text-left w-full")
                    .color("${C.text}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("@{item.subtitle}")
                    .tw("text-[13px] mt-0.5 text-left w-full")
                    .color("${C.muted}")
                    .maxLines(1)
                    .textOverflow("ellipsis")
                  Text("@{item.quality}")
                    .tw("text-[11px] mt-1 text-left w-full")
                    ${MONO}
                    .color("${C.faint}")
                    .maxLines(1)
                }
                .tw("flex-1 min-w-0 ml-3.5 items-start overflow-hidden")
              }
              .tw("items-center w-full")
            }
            .tw("flex-1 min-w-0 bg-transparent border-0 p-0 items-stretch")
            .opacity({ default: 1, active: 0.6 })
            .transition(140, easeOut)
            .onClick(@actions.openStation, id: "@{item.id}")
${playButton(40, "ml-3", true)}
          }
          .tw("items-center py-2 min-w-0")
          .enter(fade, duration: 200)
        }
        .gridColumns({ default: 1, md: 2 })
        .columnGap(40)
        .rowGap(4)
        .tw("w-full")
        ${when ? "}" : ""}`;

/**
 * Horizontal carousel of artwork tiles bound to `@state.<binding>`. The play
 * button overlaps the artwork's corner (a Stack sibling, not a nested button),
 * placed by top/left margins: the one Stack anchoring every renderer agrees on.
 */
export const stationTiles = (binding: string, size = 148) => `
          Row {
            ForEach(items: @state.${binding}, key: "id") {
              Column {
                Stack {
                  Button {
${art("@{item.art}", size, 22, "@{item.name} logo")}
                  }
                  .tw("bg-transparent border-0 p-0")
                  .opacity({ default: 1, active: 0.7 })
                  .transition(140, easeOut)
                  .onClick(@actions.openStation, id: "@{item.id}")
                  .label("Station details")
${playButton(40)}
                    .marginLeft(${size - 48})
                    .marginTop(${size - 48})
                    .boxShadow("0 6px 16px rgba(0, 0, 0, 0.45)")
                }
                .width(${size})
                .height(${size})
                Text("@{item.name}")
                  .tw("text-[15px] font-bold mt-2.5 text-left w-full")
                  .color("${C.text}")
                  .maxLines(1)
                  .textOverflow("ellipsis")
                Text("@{item.subtitle}")
                  .tw("text-xs mt-0.5 text-left w-full")
                  .color("${C.muted}")
                  .maxLines(1)
                  .textOverflow("ellipsis")
              }
              .tw("shrink-0 mr-3.5 items-start")
              .width(${size})
              .enter(fade, duration: 220)
            }
          }
          .scrollable("horizontal")
          .tw("flex-row w-full pb-1")`;

/** Round ghost icon button (back, close, favourite…). */
export const iconButton = (icon: string, action: string, label: string, size = 44) => `
          Button {
            Icon(@resources.${icon})
              .size(20)
              .color("${C.text}")
          }
          .tw("rounded-full items-center justify-center shrink-0 p-0")
          .width(${size})
          .height(${size})
          .border("1px solid ${C.line}")
          .backgroundColor({ default: "rgba(244, 238, 225, 0.06)", hover: "rgba(244, 238, 225, 0.14)" })
          .opacity({ default: 1, active: 0.6 })
          .transition(140, easeOut)
          .onClick(@actions.${action})
          .label("${label}")`;

/** Back button, kicker and a large title for sub-screens. */
export const subHeader = (title: string, subtitle = "", label = "") => `
        Row {
${iconButton("chevron-left", "back", "Back")}
          ${label ? kicker(label, C.faint, "ml-3.5") : ""}
        }
        .tw("items-center pt-5")
        Heading("${title}", level: 1)
          .tw("text-[34px] font-black text-left mt-4 leading-tight tracking-tight w-full")
          .color("${C.text}")
          .maxLines(2)
          .textOverflow("ellipsis")
        ${subtitle ? `Text("${subtitle}")
          .tw("text-sm mt-1 mb-4 text-left w-full")
          .color("${C.muted}")` : `Box {}.height(16)`}`;

/** Shimmer placeholder rows while a list loads. */
export const skeletonRows = (n: number) =>
  Array.from({ length: n }, () => `
          Row {
            Box {}.tw("w-14 h-14 rounded-[14px]").backgroundColor("${C.surface}")
            Column {
              Box {}.tw("h-3.5 w-44 rounded").backgroundColor("${C.surface}")
              Box {}.tw("h-2.5 w-28 mt-2.5 rounded").backgroundColor("${C.surface}")
            }
            .tw("ml-3.5 items-start")
          }
          .tw("items-center py-2")
          .animate(shimmer)`).join("");

/** Shimmer placeholder tiles for a carousel. */
export const skeletonTiles = (n: number, size = 148) => `
          Row {
${Array.from({ length: n }, () => `            Box {}.width(${size}).height(${size}).tw("rounded-[22px] mr-3.5 shrink-0").backgroundColor("${C.surface}")`).join("\n")}
          }
          .tw("w-full overflow-hidden")
          .animate(shimmer)`;

/**
 * Empty / error state: an icon in a ringed badge, a headline, a line of
 * help, and optionally one action button ("cta" = [label, applicators]).
 * Set flush left: the desktop renderer does not centre wrapped lines.
 */
export const notice = (
  icon: string,
  title: string,
  body: string,
  cta?: [label: string, onClick: string],
  tone = C.text,
) => `
          Row {
            Column {
              Icon(@resources.${icon})
                .size(22)
                .color("${tone}")
            }
            .tw("w-12 h-12 rounded-full items-center justify-center shrink-0")
            .border("1px dashed ${C.lineStrong}")
            Column {
              Text("${title}")
                .tw("text-lg font-bold text-left w-full")
                .color("${C.text}")
              Text("${body}")
                .tw("text-sm mt-1 text-left leading-5 w-full")
                .color("${C.muted}")
              ${cta ? `Button {
                Text("${cta[0]}")
                  .tw("text-sm font-bold")
                  .color("${C.ink}")
              }
              .tw("mt-4 h-10 px-5 rounded-full border-0 items-center justify-center")
              .backgroundColor({ default: "${C.text}", hover: "#FFFFFF" })
              .opacity({ default: 1, active: 0.7 })
              ${cta[1]}` : ""}
            }
            .tw("flex-1 min-w-0 ml-4 items-start")
          }
          .tw("items-start p-5 mt-3 rounded-[24px] w-full")
          .border("1px solid ${C.line}")
          .backgroundColor("${C.surface}")`;

/** Error card with retry. */
export const errorCard = (messageBinding: string) =>
  notice("alert", "Lost the signal", messageBinding, ["Try again", ".onClick(@actions.retry)"], C.accent);

/** Screen scroll container wrapper. */
export const screen = (name: string, body: string) => `
    module ${name} {
      Column {
        Column {
${body}
        }
        .tw("w-full px-5 md:px-10 pb-8")
        .maxWidth(1080)
      }
      .horizontalAlignment("center")
      .scrollable(true)
      .tw("flex-1 w-full min-h-0")
      .backgroundColor("${C.bg}")
    }`;
