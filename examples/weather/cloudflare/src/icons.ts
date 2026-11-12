/**
 * Weather glyphs as SVG data URIs.
 *
 * `Icon(@resources.x)` resolves its name at template-expansion time, so a
 * per-row icon inside `ForEach` would need an `If` chain per glyph. A data
 * URI is just a string, so rows bind `Image(src: "@{item.icon}")` directly,
 * and the glyphs can be multi-colour.
 */

const svg = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">${body}</svg>`,
  )}`;

const SUN_CORE = `<circle cx="32" cy="32" r="11" fill="#FFD43B"/>`;
const SUN_RAYS = [0, 45, 90, 135, 180, 225, 270, 315]
  .map(
    (a) =>
      `<line x1="32" y1="9" x2="32" y2="15" stroke="#FFC233" stroke-width="3.5" stroke-linecap="round" transform="rotate(${a} 32 32)"/>`,
  )
  .join("");
const sun = (dx = 0, dy = 0, s = 1) => `<g transform="translate(${dx} ${dy}) scale(${s})">${SUN_RAYS}${SUN_CORE}</g>`;
const moon = (dx = 0, dy = 0, s = 1) =>
  `<g transform="translate(${dx} ${dy}) scale(${s})"><path d="M40 12a20 20 0 1 0 12 30A16 16 0 0 1 40 12z" fill="#E8EEFF"/></g>`;
const CLOUD_PATH = "M19 50h28a11 11 0 0 0 1.5-21.9A15 15 0 0 0 20 25.5 12.3 12.3 0 0 0 19 50z";
const cloud = (fill = "#F4F7FB", dy = 0) =>
  `<path d="${CLOUD_PATH}" fill="${fill}" transform="translate(0 ${dy})"/>`;
const drops = (color: string, long: boolean) =>
  [22, 32, 42]
    .map(
      (x) =>
        `<line x1="${x}" y1="${long ? 50 : 51}" x2="${x - 3}" y2="${long ? 59 : 56}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`,
    )
    .join("");

export const ICONS = {
  sun: svg(sun()),
  moon: svg(moon()),
  "partly-day": svg(sun(-6, -8, 0.85) + cloud("#F4F7FB", 4)),
  "partly-night": svg(moon(-4, -6, 0.8) + cloud("#DCE3EE", 4)),
  cloud: svg(cloud("#C9D3E0", -6) + cloud("#F4F7FB", 2)),
  fog: svg(
    cloud("#E2E8F0", -6) +
      [46, 53, 60]
        .map((y, i) => `<line x1="${12 + i * 3}" y1="${y}" x2="${50 - i * 2}" y2="${y}" stroke="#CBD5E1" stroke-width="3" stroke-linecap="round"/>`)
        .join(""),
  ),
  drizzle: svg(cloud("#E5EAF1", -6) + drops("#7DD3FC", false)),
  rain: svg(cloud("#CBD5E1", -6) + drops("#38BDF8", true)),
  snow: svg(
    cloud("#EEF2F7", -6) +
      [21, 32, 43]
        .map((x, i) => `<circle cx="${x}" cy="${i === 1 ? 57 : 52}" r="3" fill="#FFFFFF" stroke="#BAE6FD" stroke-width="1.2"/>`)
        .join(""),
  ),
  storm: svg(cloud("#94A3B8", -6) + `<path d="M34 42l-8 12h7l-4 9 11-13h-7l4-8z" fill="#FACC15"/>`),
  locate: svg(`<path d="M52 12L12 29l17 5 5 17z" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linejoin="round"/>`),
  locateOn: svg(`<path d="M52 12L12 29l17 5 5 17z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4" stroke-linejoin="round"/>`),
} as const;

export type IconName = keyof typeof ICONS;
