/**
 * Branded CLI banner.
 *
 * Rendered in the brand pink (#FFA7E1) using Unicode box-drawing
 * characters — they read cleanly at every terminal font size and avoid
 * the ragged look of ASCII `_____` / `|` glyphs.
 */

import { boldPink, dim, pink } from "./colors.js";

/**
 * Three-line "hypen" wordmark + optional tagline. Returns a string with
 * a trailing newline so it can be dropped into `console.log` without
 * further formatting.
 */
export function renderBanner(version?: string, tagline?: string): string {
  const lines = [
    "╦ ╦╦ ╦╔═╗╔═╗╔╗╔",
    "╠═╣╚╦╝╠═╝║╣ ║║║",
    "╩ ╩ ╩ ╩  ╚═╝╝╚╝",
  ].map((l) => "  " + boldPink(l));

  const meta: string[] = [];
  if (version) meta.push(pink(`v${version}`));
  if (tagline) meta.push(dim(tagline));
  const footer = meta.length ? "  " + meta.join(dim(" · ")) : "";

  return `\n${lines.join("\n")}\n${footer ? footer + "\n" : ""}`;
}
