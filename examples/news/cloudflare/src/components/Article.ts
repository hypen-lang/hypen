import { app } from "@hypen-space/core";
import { hub } from "../scope";
import { ACCENT, BORDER, MUTED, PAGE, SERIF, TEXT, skeletonRows } from "../theme";

// A Wikipedia page summary (/wiki/:title), opened from Today and On this day.
// The hero carries a constant `wiki-hero` shared-element key; the list screen
// marks exactly one thumbnail with the same key right before it pushes, so the
// thumbnail flies into place (see movie-discovery's MovieDetail for the
// reasoning behind a static key on the destination).

interface ArticleState {
  status: "loading" | "ready" | "error";
  title: string;
  name: string;
  description: string;
  extract: string;
  image: string;
  hasImage: boolean;
  aspect: number;
  page: string;
}

const EMPTY: ArticleState = {
  status: "loading",
  title: "",
  name: "",
  description: "",
  extract: "",
  image: "",
  hasImage: false,
  aspect: 1.5,
  page: "",
};

const opening = new WeakMap<object, string>();

async function load(state: ArticleState, title: string) {
  opening.set(state, title);
  Object.assign(state, { ...EMPTY, name: title.replace(/_/g, " ") });
  try {
    const s = await hub().summary(title);
    if (opening.get(state) !== title) return;
    state.title = s.title;
    state.name = s.name || state.name;
    state.description = s.description;
    state.extract = s.extract;
    state.image = s.image;
    state.hasImage = s.image !== "";
    state.aspect = s.width && s.height ? Math.max(0.7, Math.min(2, s.width / s.height)) : 1.5;
    state.page = s.page;
    state.status = "ready";
  } catch (err) {
    console.warn("news: summary failed:", err instanceof Error ? err.message : err);
    if (opening.get(state) === title) state.status = "error";
  }
}

export default app
  .module("Article")
  .defineState<ArticleState>({ ...EMPTY })
  .onActivated((state, context) => {
    const path = context?.router?.getCurrentPath() ?? "";
    const raw = context?.router?.matchPath("/wiki/:title", path)?.params.title ?? "";
    let title = raw;
    try {
      title = decodeURIComponent(raw);
    } catch {
      /* already decoded */
    }
    if (title && (opening.get(state) !== title || state.status === "error")) void load(state, title);
  })
  .onAction("back", ({ context }) => {
    const router = context?.router;
    if (!router) return;
    const before = router.getCurrentPath();
    router.back();
    if (router.getCurrentPath() === before) router.push("/");
  })
  .onAction("retry", async ({ state }) => {
    const title = opening.get(state);
    if (title) await load(state, title);
  })
  .ui(`
    module Article {
      Column {
        Row {
          Button {
            Icon(@resources.chevron-left).size(20).color("${TEXT}")
          }
          .tw("w-10 h-10 rounded-full border items-center justify-center")
          .borderColor("${BORDER}")
          .backgroundColor("rgba(255,255,255,0.06)")
          .opacity({ default: 1, active: 0.6 })
          .label("Back")
          .onClick(@actions.back)
          Row {
            Icon(@resources.globe).size(14).color("${MUTED}")
            Text("Wikipedia").tw("text-[13px] font-medium ml-1.5").color("${MUTED}")
          }
          .tw("flex-1 items-center justify-center pr-10")
        }
        .tw("px-4 pt-5 pb-3 items-center")
        ${PAGE}

        Column {
          Image(src: "@{state.image}", alt: "@{state.name}")
            .objectFit("cover")
            .aspectRatio("@{state.aspect}")
            .tw("w-full rounded-3xl border")
            .borderColor("${BORDER}")
            .backgroundColor("#1A1A20")
            .opacity("@{state.hasImage || state.status == 'loading' ? 1 : 0}")
            .sharedElement("wiki-hero", curve: spring, duration: 340)

          Heading("@{state.name}", level: 1)
            .tw("text-[28px] md:text-[34px] font-bold leading-tight tracking-tight mt-5")
            .fontFamily("${SERIF}")
            .color("${TEXT}")
          Text("@{state.description}").tw("text-[14px] mt-1.5").color("${MUTED}")

          If(condition: "@{state.status == 'loading'}") {
            Column {
${skeletonRows(3)}
            }
          }

          If(condition: "@{state.status == 'error'}") {
            Button { Text("Couldn't load this page — try again").tw("text-[13px] font-semibold").color("#0E0E11") }
              .tw("mt-5 px-4 py-2.5 rounded-xl border-0")
              .backgroundColor("${ACCENT}")
              .onClick(@actions.retry)
          }

          If(condition: "@{state.status == 'ready'}") {
            Column {
              Text("@{state.extract}")
                .tw("text-[16px] leading-relaxed")
                .fontFamily("${SERIF}")
                .color("#DADAE0")
              Link(href: "@{state.page}", target: "_blank", rel: "noopener noreferrer") {
                Row {
                  Icon(@resources.external).size(16).color("#0E0E11")
                  Text("Read on Wikipedia").tw("text-[14px] font-semibold ml-2").color("#0E0E11")
                }
                .tw("items-center justify-center")
              }
              .tw("mt-6 h-11 w-full rounded-xl flex items-center justify-center no-underline")
              .backgroundColor("${ACCENT}")
              .opacity({ default: 1, active: 0.75 })
            }
            .tw("mt-5 items-stretch")
            .enter(fade, duration: 280)
          }
        }
        .tw("px-4 pb-16")
        ${PAGE}
      }
      .scrollable(true)
      .tw("flex-1")
    }
  `);
