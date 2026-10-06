/**
 * A Grid's column/row count: `.gridColumns(N)` / `.gridRows(N)` and the
 * Grid `columns`/`rows` props. Counts are the only track form every
 * renderer supports (DOM, Canvas, iOS, Android, desktop). The engine may
 * deliver the number as a string ("3"). Anything else is ignored (`null`).
 */
export function trackCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}
