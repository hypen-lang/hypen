/**
 * OS file-drag plumbing shared by the DOM and Canvas renderers.
 *
 * Only what the browser exposes BEFORE a drop is read here: whether the
 * drag carries files (`dataTransfer.types` contains `"Files"`), how many
 * items it holds, and each file item's `kind` / MIME `type`. File names and
 * bytes are never touched (browsers hide them until the drop anyway, and
 * the renderers never take the drop — see docs/dnd.md, "Files from the OS").
 */

/** The `dataTransfer` surface the renderers read (structural, test-friendly). */
export interface FileDragTransfer {
  types?: ArrayLike<string> | null;
  items?: { length: number; [index: number]: { kind?: string; type?: string } | undefined } | null;
  dropEffect?: string;
}

/** The drag event's transfer, if any. */
export function transferOf(event: unknown): FileDragTransfer | null {
  return ((event as { dataTransfer?: FileDragTransfer | null })?.dataTransfer ?? null) as FileDragTransfer | null;
}

/** Whether a drag carries files from outside the page (the OS / another app). */
export function dragCarriesFiles(event: unknown): boolean {
  const types = transferOf(event)?.types;
  return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
}

/** How many items the drag holds (`0` when unknown). */
export function dragItemCount(event: unknown): number {
  const n = transferOf(event)?.items?.length;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * MIME types of the drag's file items, for `accept:` matching
 * (`fileDragMatchesAccept`). `""` for a file item whose type the browser
 * does not report; `null` when the per-item list is unavailable (unknown ⇒
 * the caller treats it as a match).
 */
export function dragFileTypes(event: unknown): string[] | null {
  const items = transferOf(event)?.items;
  if (!items || typeof items.length !== "number" || items.length === 0) return null;
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) return null; // per-item details unavailable
    if (item.kind !== undefined && item.kind !== "file") continue;
    out.push(typeof item.type === "string" ? item.type : "");
  }
  return out.length > 0 ? out : null;
}
