/**
 * Branded CLI banner.
 *
 * Rendered in the brand pink (#FFA7E1) using Unicode box-drawing
 * characters — they read cleanly at every terminal font size and avoid
 * the ragged look of ASCII `_____` / `|` glyphs.
 */

import { boldPink, dim, pink } from "./colors.js";

/**
 * The Unicode wordmark mojibakes on terminals where stdout decoding
 * silently disagrees with the byte stream — even when LANG/LC_CTYPE
 * claim UTF-8 (we can't reliably probe the actual rendering layer).
 * Default to ASCII; opt in to box chars via HYPEN_BANNER=unicode.
 */
function supportsUnicode(): boolean {
  return (process.env.HYPEN_BANNER || "").toLowerCase() === "unicode";
}

const UNICODE_LINES = [
  "╦ ╦╦ ╦╔═╗╔═╗╔╗╔",
  "╠═╣╚╦╝╠═╝║╣ ║║║",
  "╩ ╩ ╩ ╩  ╚═╝╝╚╝",
];

const ASCII_LINES = [
  "  _   _  __   __ ____   _____  _   _ ",
  " | | | | \\ \\ / /|  _ \\ | ____|| \\ | |",
  " | |_| |  \\ V / | |_) ||  _|  |  \\| |",
  " |  _  |   | |  |  __/ | |___ | |\\  |",
  " |_| |_|   |_|  |_|    |_____||_| \\_|",
];

/**
 * Three-line "hypen" wordmark + optional tagline. Returns a string with
 * a trailing newline so it can be dropped into `console.log` without
 * further formatting.
 */
export function renderBanner(version?: string, tagline?: string): string {
  const lines = (supportsUnicode() ? UNICODE_LINES : ASCII_LINES).map(
    (l) => "  " + boldPink(l)
  );

  const meta: string[] = [];
  if (version) meta.push(pink(`v${version}`));
  if (tagline) meta.push(dim(tagline));
  const footer = meta.length ? "  " + meta.join(dim(" · ")) : "";

  return `\n${lines.join("\n")}\n${footer ? footer + "\n" : ""}`;
}
