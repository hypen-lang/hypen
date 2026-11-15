// Every station gets a stable colour pair, hashed from its id. The bright
// half paints the generated monogram artwork (art.ts); the deep half is a
// background that cream text stays readable on (>= 6:1), used for the
// featured card, the station page and the player backdrop. Stations with a
// real logo get a colour "paired" with it; monogram stations match exactly.

export interface Tint {
  /** Saturated mid-tone: artwork fill, glows. */
  glow: string;
  /** Darkened partner: safe behind cream text. */
  tint: string;
}

export const PALETTE: Tint[] = [
  { glow: "#E2502F", tint: "#7E2414" }, // signal red
  { glow: "#D08A1F", tint: "#6E460B" }, // ochre
  { glow: "#2F9A78", tint: "#134E3B" }, // sea green
  { glow: "#3B78DB", tint: "#17397A" }, // cobalt
  { glow: "#8459D6", tint: "#40267F" }, // violet
  { glow: "#CF4A86", tint: "#731D45" }, // magenta
  { glow: "#1F99AB", tint: "#0C4C57" }, // teal
  { glow: "#7C9A33", tint: "#3B4C12" }, // olive
];

export function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function tintFor(key: string): Tint {
  return PALETTE[hash(key) % PALETTE.length];
}
