/**
 * Branded CLI banner.
 *
 * A lowercase "hypen" wordmark in a sleek slanted figlet face, rendered in
 * the brand pink (#FFA7E1). Pure ASCII (no box-drawing) so it reads as
 * letters at every terminal font size.
 */

import { boldPink, dim, pink } from "./colors.js";

/**
 * The "hypen" wordmark + optional tagline. Returns a string with a
 * trailing newline so it can be dropped into `console.log` without
 * further formatting.
 */
export function renderBanner(version?: string, tagline?: string): string {
  const lines = [
    "    __",
    "   / /_  __  ______  ___  ____",
    "  / __ \\/ / / / __ \\/ _ \\/ __ \\",
    " / / / / /_/ / /_/ /  __/ / / /",
    "/_/ /_/\\__, / .___/\\___/_/ /_/",
    "      /____/_/",
  ].map((l) => "  " + boldPink(l));

  const meta: string[] = [];
  if (version) meta.push(pink(`v${version}`));
  if (tagline) meta.push(dim(tagline));
  const footer = meta.length ? "  " + meta.join(dim(" · ")) : "";

  return `\n${lines.join("\n")}\n${footer ? footer + "\n" : ""}`;
}
