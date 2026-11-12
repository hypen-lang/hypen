// Inline SVG icon resources, rendered via `Icon(@resources.<name>)`.
// Feather-style 24px strokes on `currentColor`, so `.color(...)` tints them.

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

const fill = (d: string) => `<path d="${d}" fill="currentColor"/>`;

export const resources: Record<string, string> = {
  "sun": iconSvg(
    `<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/>` +
      stroke("M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"),
  ),
  "zap": iconSvg(stroke("M13 2L3 14h9l-1 8 10-12h-9l1-8z")),
  "calendar": iconSvg(
    stroke("M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z") + stroke("M16 2v4M8 2v4M3 10h18"),
  ),
  "bookmark": iconSvg(stroke("M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16")),
  "bookmark-fill": iconSvg(fill("M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z")),
  "chevron-left": iconSvg(stroke("M15 18l-6-6 6-6")),
  "chevron-right": iconSvg(stroke("M9 18l6-6-6-6")),
  "chevron-down": iconSvg(stroke("M6 9l6 6 6-6")),
  "external": iconSvg(stroke("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6") + stroke("M15 3h6v6") + stroke("M10 14L21 3")),
  "message": iconSvg(stroke("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")),
  "arrow-up": iconSvg(stroke("M12 19V5") + stroke("M5 12l7-7 7 7")),
  "link": iconSvg(stroke("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71") + stroke("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")),
  "trending": iconSvg(stroke("M23 6l-9.5 9.5-5-5L1 18") + stroke("M17 6h6v6")),
  "globe": iconSvg(
    `<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>` +
      stroke("M2 12h20") +
      stroke("M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"),
  ),
  "image": iconSvg(
    stroke("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z") +
      `<circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>` +
      stroke("M21 15l-5-5L5 21"),
  ),
  "x": iconSvg(stroke("M18 6L6 18") + stroke("M6 6l12 12")),
  "check": iconSvg(stroke("M20 6L9 17l-5-5")),
};
