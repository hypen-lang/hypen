// Inline SVG icon resources for the calorie-counter UI, rendered via
// `Icon(@resources.<name>)`. Feather-style 24px strokes on `currentColor`,
// so `.color(...)` tints them. Food items intentionally keep their emoji —
// they're content, not chrome.

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  "home": iconSvg(stroke("M3 10.5L12 3l9 7.5") + stroke("M5 9.5V21h14V9.5") + stroke("M10 21v-6h4v6")),
  "book": iconSvg(
    stroke("M4 19.5A2.5 2.5 0 0 1 6.5 17H20") +
      stroke("M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2"),
  ),
  "chart": iconSvg(stroke("M18 20V10") + stroke("M12 20V4") + stroke("M6 20v-6")),
  "user": iconSvg(stroke("M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2") + stroke("M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8")),
  "plus": iconSvg(stroke("M12 5v14") + stroke("M5 12h14")),
  "check": iconSvg(stroke("M20 6L9 17l-5-5")),
  "x": iconSvg(stroke("M18 6L6 18") + stroke("M6 6l12 12")),
  "search": iconSvg(stroke("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16") + stroke("M21 21l-4.35-4.35")),
  "settings": iconSvg(
    stroke("M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5") +
      stroke("M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.6 20a1.65 1.65 0 0 0-1.82-.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 8.6a1.65 1.65 0 0 0 .6 1 1.65 1.65 0 0 0 1.82.33H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.82.33 1.65 1.65 0 0 0-.69.74"),
  ),
  "bell": iconSvg(
    stroke("M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9") + stroke("M13.73 21a2 2 0 0 1-3.46 0"),
  ),
  "chevron-left": iconSvg(stroke("M15 18l-6-6 6-6")),
  "chevron-right": iconSvg(stroke("M9 18l6-6-6-6")),
  "trash": iconSvg(
    stroke("M3 6h18") +
      stroke("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2") +
      stroke("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6") +
      stroke("M10 11v6") +
      stroke("M14 11v6"),
  ),
  "flame": iconSvg(
    stroke("M12 22c4.4 0 8-3.6 8-8 0-3.5-2.5-6.3-4.5-8.5C13.5 3.3 12 2 12 2s.5 3-1.5 5C8.5 9 4 10.5 4 14c0 4.4 3.6 8 8 8") +
      stroke("M12 22c2.2 0 4-1.8 4-4 0-2.5-2-3.5-4-6-2 2.5-4 3.5-4 6 0 2.2 1.8 4 4 4"),
  ),
  "utensils": iconSvg(
    stroke("M4 3v8") + stroke("M8 3v8") + stroke("M4 7h4") + stroke("M6 11v10") +
      stroke("M16 3c2 1.5 3 4 3 7s-1 5.5-3 7V3") + stroke("M16 17v4"),
  ),
};
