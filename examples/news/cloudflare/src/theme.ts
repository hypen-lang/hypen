// Palette + DSL snippets shared by the screens. Templates are plain strings,
// so reusable pieces are just functions that return DSL.

export const BG = "#0E0E11";
export const CARD = "rgba(255, 255, 255, 0.04)";
export const BORDER = "rgba(255, 255, 255, 0.08)";
export const TEXT = "#F4F4F5";
export const MUTED = "#8E8E99";
export const DIM = "#6B6B76";
export const ACCENT = "#FF7A1A";
export const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

/** Centered content column: phone-first, capped on desktop. */
export const PAGE = `.maxWidth(760).width("100%").alignSelf("center")`;

/** Same column for an element with a 16px side margin (width 100% + margin would overflow). */
export const INSET = `.maxWidth(728).width("calc(100% - 32px)").alignSelf("center")`;

/**
 * One Hacker News story row. `v` is the ForEach alias. The row's actions are
 * `openStory` / `toggleSave` (each screen module registers both), so the same
 * row works on Today, the HN tabs and Saved.
 *
 * Live updates: the hub re-polls HN and the module rewrites the keyed list;
 * `.layout(spring)` FLIPs re-ranked rows into place, `.enter`/`.exit` cover
 * stories entering or leaving the top 30, and `bumped` (score rose since the
 * last poll) tints the row for one cycle under a `.transition`.
 */
export function storyRow(v: string, { rank = true }: { rank?: boolean } = {}): string {
  const rankCol = rank
    ? `
        Column {
          Text("@{${v}.rank}")
            .tw("text-[15px] font-bold")
            .fontFamily("${SERIF}")
            .color("@{${v}.read ? '${DIM}' : '${ACCENT}'}")
          Text("@{${v}.delta}")
            .tw("text-[10px] font-bold mt-0.5")
            .color("@{${v}.deltaColor}")
            .opacity("@{${v}.delta == '' ? 0 : 1}")
            .transition(300, easeOut)
        }
        .tw("w-8 shrink-0 items-center pt-0.5")`
    : "";
  return `
      Row {
${rankCol}
        Button {
          Column {
            Text("@{${v}.title}")
              .tw("text-[16px] leading-snug text-left")
              .fontFamily("${SERIF}")
              .fontWeight(600)
              .color("@{${v}.read ? '${MUTED}' : '${TEXT}'}")
            Text("@{${v}.domain}")
              .tw("text-[12px] mt-1 text-left truncate w-full")
              .color("${ACCENT}")
              .opacity(0.85)
            Row {
              Text("@{${v}.scoreLabel}")
                .tw("text-[12px] font-semibold")
                .color("@{${v}.bumped ? '#34D399' : '#C9C9D1'}")
                .transition(400, easeOut)
              Text("@{${v}.commentsLabel}")
                .tw("text-[12px] ml-2.5")
                .color("${MUTED}")
              Text("@{${v}.byline}")
                .tw("text-[12px] ml-2.5 truncate")
                .color("${DIM}")
            }
            .tw("mt-1.5 items-center w-full min-w-0")
          }
          .tw("items-start w-full min-w-0")
        }
        .tw("flex-1 min-w-0 bg-transparent border-0 p-0 text-left")
        .opacity({ default: 1, active: 0.6 })
        .transition(160, easeOut)
        .onClick(@actions.openStory, id: "@{${v}.id}")

        Button {
          // Icon names resolve at template time (not per binding), so the
          // saved look is colour + a tinted pill rather than a second glyph.
          Icon(@resources.bookmark)
            .size(17)
            .color("@{${v}.saved ? '${ACCENT}' : '${DIM}'}")
        }
        .tw("w-9 h-9 shrink-0 ml-1 rounded-full border-0 items-center justify-center")
        .backgroundColor("@{${v}.saved ? 'rgba(255, 122, 26, 0.14)' : 'rgba(255, 255, 255, 0)'}")
        .transition(220, easeOut)
        .opacity({ default: 1, active: 0.5 })
        .label("Bookmark")
        .onClick(@actions.toggleSave, id: "@{${v}.id}", animate: spring)
      }
      .tw("px-3 py-3 rounded-2xl items-start")
      .backgroundColor("@{${v}.bumped ? 'rgba(52, 211, 153, 0.08)' : 'rgba(255, 255, 255, 0)'}")
      .transition(500, easeOut)
      .enter(fade, slide, from: bottom, duration: 260)
      .exit(fade, duration: 180)
      .layout(spring)`;
}

/** Section heading with an optional "See all" router link. */
export function sectionHeader(title: string, to?: string, note?: string): string {
  const more = to
    ? `
        Button {
          Row {
            Text("See all").tw("text-[13px] font-semibold").color("${ACCENT}")
            Icon(@resources.chevron-right).size(14).color("${ACCENT}")
          }
          .tw("items-center gap-0.5")
        }
        .tw("bg-transparent border-0 p-1")
        .opacity({ default: 1, active: 0.5 })
        .onClick(@router.push, to: "${to}")`
    : "";
  const sub = note ? `Text("${note}").tw("text-[12px] mt-0.5").color("${DIM}")` : "";
  return `
      Row {
        Column {
          Heading("${title}", level: 2)
            .tw("text-[20px] font-bold tracking-tight")
            .fontFamily("${SERIF}")
            .color("${TEXT}")
          ${sub}
        }
        .tw("flex-1")
${more}
      }
      .tw("px-4 pt-7 pb-3 items-end")
      ${PAGE}`;
}

/** Shimmering placeholder rows while the first fetch is in flight. */
export function skeletonRows(n: number): string {
  return Array.from({ length: n }, (_, i) => `
        Column {
          Box {}.tw("h-4 rounded-md w-[85%]").backgroundColor("rgba(255,255,255,0.07)")
          Box {}.tw("h-3 rounded-md w-[45%] mt-2").backgroundColor("rgba(255,255,255,0.05)")
        }
        .tw("px-4 py-4")
        .animate(shimmer, delay: ${i * 90})`).join("\n");
}
