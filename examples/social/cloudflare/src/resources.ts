/**
 * Static SVG resource bundle. Each `.svg` from `src/resources/` is
 * pulled in as a string via wrangler's `Text` rule and keyed by its
 * basename — same convention the Bun server's `resourcesDir()` uses
 * (`heart.svg` → `Icon(@resources.heart)`).
 *
 * The map is registered with the engine in `src/do.ts` so the engine
 * can resolve `Icon(@resources.foo)` references on the server side
 * and inject SVG path data straight into the Create patches.
 */

// @ts-ignore
import bookmark from "./resources/bookmark.svg";
// @ts-ignore
import camera from "./resources/camera.svg";
// @ts-ignore
import grid from "./resources/grid.svg";
// @ts-ignore
import heart from "./resources/heart.svg";
// @ts-ignore
import home from "./resources/home.svg";
// @ts-ignore
import image from "./resources/image.svg";
// @ts-ignore
import menu from "./resources/menu.svg";
// @ts-ignore
import messageCircle from "./resources/message-circle.svg";
// @ts-ignore
import moreHorizontal from "./resources/more-horizontal.svg";
// @ts-ignore
import plusSquare from "./resources/plus-square.svg";
// @ts-ignore
import plus from "./resources/plus.svg";
// @ts-ignore
import search from "./resources/search.svg";
// @ts-ignore
import send from "./resources/send.svg";
// @ts-ignore
import user from "./resources/user.svg";

export const resources: Record<string, string> = {
  bookmark: bookmark as string,
  camera: camera as string,
  grid: grid as string,
  heart: heart as string,
  home: home as string,
  image: image as string,
  menu: menu as string,
  "message-circle": messageCircle as string,
  "more-horizontal": moreHorizontal as string,
  "plus-square": plusSquare as string,
  plus: plus as string,
  search: search as string,
  send: send as string,
  user: user as string,
};
