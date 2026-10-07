import type { GlobalContext } from "@hypen-space/core";
import type { DndEventPayload } from "@hypen-space/core";
import {
  MAX_DRIVE_BYTES,
  MAX_FILE_BYTES,
  ROOT,
  currentDrive,
  previewPath,
  sniffImageType,
  type DriveNode,
} from "./drive";
import { getGeo } from "./geo";

// The Files app — a personal drive on the home screen, laid out like a
// native file browser: a toolbar (path, sort, grid/list toggle, new folder,
// upload), a grid or list of items, and a details bar for the selection.
//
// Bytes only ever move through the device plane (RFC 001):
//
// - Upload: `file.pick`. The visitor's DeviceHost shows its own consent
//   dialog with a drop zone and an OS picker behind Continue. Dragging files
//   from the desktop over the pane lights it up (`.dropZone(files: true)` +
//   its `over` pose) and fires `.onFileDragEnter`, which asks
//   for the pick right away — the host dialog pops up under the still-held
//   drag and the files are released onto it. The browser itself never
//   receives file data.
// - Download: `file.save`. The host asks for consent and a destination, then
//   pulls the bytes with its own credit.
//
// Inside the drive, items are ordinary Hypen drag-and-drop: every tile/row is
// `.draggable`, folders and the breadcrumb are `.dropZone`s, and `moveInto`
// re-parents the dropped item.
//
// Sorting happens here, in the module: `entries` is always the sorted list
// (folders first), so the template only ever renders it in order.

export type FilesView = "grid" | "list";
export type SortKey = "name" | "kind" | "modified" | "size";

const SORT_KEYS: readonly SortKey[] = ["name", "kind", "modified", "size"];
const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  kind: "Kind",
  modified: "Date Modified",
  size: "Size",
};

export function isSortKey(v: unknown): v is SortKey {
  return typeof v === "string" && (SORT_KEYS as readonly string[]).includes(v);
}

export function isFilesView(v: unknown): v is FilesView {
  return v === "grid" || v === "list";
}

export interface FileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  isImage: boolean;
  /** `/drive/<id>` for image thumbnails, "" otherwise. */
  previewUrl: string;
  /** "Folder", "PNG image", "PDF document", … */
  kind: string;
  /** Short badge on a document icon ("PDF", "ZIP"), "" for none. */
  ext: string;
  /** Badge colour for the document icon. */
  tint: string;
  /** "1.2 MB", or "3 items" for a folder. */
  size: string;
  /** "Today at 2:03 PM", "Sep 27, 2026 at 9:15 AM". */
  modified: string;
  /** Phone-width list subtitle: "Sep 27 · 1.2 MB". */
  detail: string;
  selected: boolean;
}

export interface FileCrumb {
  id: string;
  name: string;
  /** The open folder (rendered bold, not as a link). */
  isLast: boolean;
}

/** Direction arrow per list column ("" for the columns not sorted on). */
export type SortArrows = Record<SortKey, string>;

export interface FilesState {
  folderId: string;
  crumbs: FileCrumb[];
  /** The open folder's items, already sorted (folders first). */
  entries: FileEntry[];
  /** The open folder has nothing in it (drives the empty-state hint). */
  filesEmpty: boolean;
  /** "5 items". */
  filesCount: string;
  /** One-line status / error under the toolbar. */
  filesStatus: string;
  /** A device request (pick/save) is in flight. */
  filesBusy: boolean;
  showNewFolder: boolean;
  newFolderName: string;
  driveUsage: string;

  /** Grid or list; persisted per visitor (see launcher.ts). */
  filesView: FilesView;
  /** Sort column and direction; persisted per visitor. */
  filesSortKey: SortKey;
  filesSortDesc: boolean;
  /** "Name", "Date Modified", … for the sort button. */
  filesSortLabel: string;
  /** "↑" / "↓". */
  filesSortArrow: string;
  filesSortArrows: SortArrows;
  showSortMenu: boolean;

  /** "" when nothing is selected. */
  selectedId: string;
  /** The selected item (a blank entry when nothing is selected). */
  selection: FileEntry;
  renaming: boolean;
  renameName: string;
}

const BLANK_ENTRY: FileEntry = {
  id: "",
  name: "",
  isFolder: false,
  isImage: false,
  previewUrl: "",
  kind: "",
  ext: "",
  tint: "#6B7280",
  size: "",
  modified: "",
  detail: "",
  selected: false,
};

export function initialFilesState(): FilesState {
  return {
    folderId: ROOT,
    crumbs: [{ id: ROOT, name: "My Files", isLast: true }],
    entries: [],
    filesEmpty: true,
    filesCount: "",
    filesStatus: "",
    filesBusy: false,
    showNewFolder: false,
    newFolderName: "",
    driveUsage: "",
    filesView: "grid",
    filesSortKey: "name",
    filesSortDesc: false,
    filesSortLabel: SORT_LABELS.name,
    filesSortArrow: "↑",
    filesSortArrows: { name: " ↑", kind: "", modified: "", size: "" },
    showSortMenu: false,
    selectedId: "",
    selection: { ...BLANK_ENTRY },
    renaming: false,
    renameName: "",
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Kinds, dates
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;

interface KindInfo {
  kind: string;
  tint: string;
}

const KINDS: Array<[RegExp, KindInfo]> = [
  [/^(pdf)$/, { kind: "PDF document", tint: "#EF4444" }],
  [/^(jpe?g|png|gif|webp|avif|heic|bmp|tiff?|svg)$/, { kind: "image", tint: "#14B8A6" }],
  [/^(mp4|mov|m4v|webm|mkv|avi)$/, { kind: "video", tint: "#8B5CF6" }],
  [/^(mp3|m4a|wav|flac|aac|ogg|opus)$/, { kind: "audio", tint: "#EC4899" }],
  [/^(zip|gz|tgz|tar|rar|7z|bz2|xz)$/, { kind: "archive", tint: "#F59E0B" }],
  [/^(xlsx?|csv|numbers|ods|tsv)$/, { kind: "spreadsheet", tint: "#22C55E" }],
  [/^(pptx?|key|odp)$/, { kind: "presentation", tint: "#F97316" }],
  [/^(docx?|pages|odt|rtf)$/, { kind: "document", tint: "#3B82F6" }],
  [/^(txt|md|markdown|log)$/, { kind: "text document", tint: "#64748B" }],
  [/^(js|mjs|ts|tsx|jsx|json|html?|css|rs|py|go|kt|swift|java|c|cc|cpp|h|sh|toml|ya?ml|xml|hypen|sql)$/, { kind: "source code", tint: "#10B981" }],
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function kindOf(node: DriveNode): { kind: string; ext: string; tint: string } {
  if (node.kind === "folder") return { kind: "Folder", ext: "", tint: "#4A9FEA" };
  const ext = extensionOf(node.name);
  const badge = ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : "";
  for (const [re, info] of KINDS) {
    if (ext && re.test(ext)) {
      // "PNG image", "MP4 video" — but "PDF document" already names itself.
      const kind = info.kind.includes(" ") || !badge ? info.kind : `${badge} ${info.kind}`;
      return { kind: kind.charAt(0).toUpperCase() + kind.slice(1), ext: badge, tint: info.tint };
    }
  }
  const ct = node.contentType;
  if (ct.startsWith("image/")) return { kind: "Image", ext: badge, tint: "#14B8A6" };
  if (ct.startsWith("video/")) return { kind: "Video", ext: badge, tint: "#8B5CF6" };
  if (ct.startsWith("audio/")) return { kind: "Audio", ext: badge, tint: "#EC4899" };
  if (ct.startsWith("text/")) return { kind: "Text document", ext: badge, tint: "#64748B" };
  return { kind: badge ? `${badge} file` : "Document", ext: badge, tint: "#6B7280" };
}

/** Dates in the visitor's own timezone (from the edge geo), else UTC. */
function zoned(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const tz = getGeo().timezone;
  if (!tz) return opts;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return { ...opts, timeZone: tz };
  } catch {
    return opts;
  }
}

function dayKey(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", zoned({ year: "numeric", month: "2-digit", day: "2-digit" }));
}

function formatModified(ms: number, now = Date.now()): { long: string; short: string } {
  if (!ms) return { long: "—", short: "" };
  const time = new Date(ms).toLocaleTimeString("en-US", zoned({ hour: "numeric", minute: "2-digit" }));
  if (dayKey(ms) === dayKey(now)) return { long: `Today at ${time}`, short: "Today" };
  if (dayKey(ms) === dayKey(now - 86_400_000)) return { long: `Yesterday at ${time}`, short: "Yesterday" };
  const date = new Date(ms).toLocaleDateString("en-US", zoned({ month: "short", day: "numeric", year: "numeric" }));
  const short = new Date(ms).toLocaleDateString("en-US", zoned({ month: "short", day: "numeric" }));
  return { long: `${date} at ${time}`, short };
}

function itemCount(n: number): string {
  return n === 0 ? "Empty" : `${n} item${n === 1 ? "" : "s"}`;
}

function toEntry(node: DriveNode, selectedId: string, now: number): FileEntry {
  const isFolder = node.kind === "folder";
  // Thumbnails are a hint only: /drive/<id> sniffs the bytes and 404s
  // anything that is not really an image.
  const isImage =
    !isFolder &&
    (node.contentType.startsWith("image/") || IMAGE_EXT.test(node.name)) &&
    !/svg/i.test(node.contentType + node.name);
  const { kind, ext, tint } = kindOf(node);
  const size = isFolder ? itemCount(node.childCount) : formatBytes(node.bytes);
  const modified = formatModified(node.modifiedAt, now);
  return {
    id: node.id,
    name: node.name,
    isFolder,
    isImage,
    previewUrl: isImage ? previewPath(node.id) : "",
    kind,
    ext,
    tint,
    size,
    modified: modified.long,
    detail: [modified.short, size].filter(Boolean).join(" · "),
    selected: node.id === selectedId,
  };
}

// ---------------------------------------------------------------------------
// Sorting (server-side: `entries` is stored sorted)
// ---------------------------------------------------------------------------

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Folders always first; then the chosen key, ties broken by name. */
export function sortNodes(nodes: DriveNode[], key: SortKey, desc: boolean): DriveNode[] {
  const dir = desc ? -1 : 1;
  const kinds = new Map(nodes.map((n) => [n.id, kindOf(n).kind]));
  const byName = (a: DriveNode, b: DriveNode) => collator.compare(a.name, b.name);
  const byKey = (a: DriveNode, b: DriveNode): number => {
    switch (key) {
      case "name":
        return byName(a, b);
      case "kind":
        return collator.compare(kinds.get(a.id)!, kinds.get(b.id)!);
      case "modified":
        return a.modifiedAt - b.modifiedAt;
      case "size":
        return a.kind === "folder" ? a.childCount - b.childCount : a.bytes - b.bytes;
    }
  };
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return byKey(a, b) * dir || byName(a, b);
  });
}

function applySortLabels(state: FilesState): void {
  const arrow = state.filesSortDesc ? "↓" : "↑";
  state.filesSortLabel = SORT_LABELS[state.filesSortKey];
  state.filesSortArrow = arrow;
  state.filesSortArrows = {
    name: state.filesSortKey === "name" ? ` ${arrow}` : "",
    kind: state.filesSortKey === "kind" ? ` ${arrow}` : "",
    modified: state.filesSortKey === "modified" ? ` ${arrow}` : "",
    size: state.filesSortKey === "size" ? ` ${arrow}` : "",
  };
}

/** Re-read the open folder (falling back to the root if it vanished). */
export function refreshFiles(state: FilesState): void {
  const drive = currentDrive();
  if (!drive.isFolder(state.folderId)) state.folderId = ROOT;
  if (!isSortKey(state.filesSortKey)) state.filesSortKey = "name";
  if (!isFilesView(state.filesView)) state.filesView = "grid";
  applySortLabels(state);

  const nodes = sortNodes(drive.list(state.folderId), state.filesSortKey, state.filesSortDesc);
  if (state.selectedId && !nodes.some((n) => n.id === state.selectedId)) {
    state.selectedId = "";
    state.renaming = false;
  }
  const now = Date.now();
  state.entries = nodes.map((n) => toEntry(n, state.selectedId, now));
  state.filesEmpty = state.entries.length === 0;
  state.filesCount = state.entries.length === 1 ? "1 item" : `${state.entries.length} items`;
  state.selection = { ...(state.entries.find((e) => e.selected) ?? BLANK_ENTRY) };

  const path = drive.path(state.folderId);
  state.crumbs = path.map((c, i) => ({ id: c.id, name: c.name, isLast: i === path.length - 1 }));
  state.driveUsage = `${formatBytes(drive.usedBytes())} of ${formatBytes(MAX_DRIVE_BYTES)} used`;
}

/** Selection changed only: flip the flags without re-reading the drive. */
function applySelection(state: FilesState, id: string): void {
  state.selectedId = id;
  state.renaming = false;
  state.entries = state.entries.map((e) => (e.selected === (e.id === id) ? e : { ...e, selected: e.id === id }));
  state.selection = { ...(state.entries.find((e) => e.id === id) ?? BLANK_ENTRY) };
}

function deviceMessage(code: string, verb: "upload" | "save"): string {
  switch (code) {
    case "cancelled":
    case "denied":
      return "";
    case "unsupported":
    case "unavailable":
      return verb === "upload" ? "This device can't send files here." : "This device can't save files.";
    case "throttled":
      return verb === "upload"
        ? `Those files are too large together (max ${formatBytes(MAX_FILE_BYTES)} per upload), or a prompt is already open.`
        : "Another prompt is already open.";
    case "timeout":
      return "Timed out.";
    case "connectionLost":
      return "Connection lost. Try again.";
    default:
      return "Something went wrong.";
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function openEntry(state: FilesState, id: unknown): Promise<void> {
  if (typeof id !== "string") return;
  const drive = currentDrive();
  if (!drive.isFolder(id)) return;
  state.folderId = id;
  state.filesStatus = "";
  state.showNewFolder = false;
  state.showSortMenu = false;
  state.selectedId = "";
  state.renaming = false;
  refreshFiles(state);
}

/** Up one level (the toolbar's back arrow). */
export async function openParent(state: FilesState): Promise<void> {
  const parent = state.crumbs.at(-2);
  if (parent) await openEntry(state, parent.id);
}

/**
 * Click on a tile/row: select it. Clicking the already-selected folder opens
 * it (a tap-tap on phones, a slow double-click on desktop).
 */
export async function tapEntry(state: FilesState, id: unknown): Promise<void> {
  if (typeof id !== "string") return;
  state.showSortMenu = false;
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  if (state.selectedId === id && entry.isFolder && !state.renaming) {
    await openEntry(state, id);
    return;
  }
  if (state.selectedId !== id) applySelection(state, id);
}

export function clearSelection(state: FilesState): void {
  if (state.selectedId) applySelection(state, "");
}

export function setView(state: FilesState, view: unknown): void {
  if (!isFilesView(view) || state.filesView === view) return;
  state.filesView = view;
}

/**
 * Sort by `key`. Choosing the current key again flips the direction (a list
 * column header); a new key starts in its natural direction — A→Z for
 * names and kinds, newest/largest first for dates and sizes.
 */
export function setSort(state: FilesState, key: unknown, dir?: unknown): void {
  if (!isSortKey(key)) return;
  state.showSortMenu = false;
  if (dir === "keep" && key === state.filesSortKey) return;
  if (dir === "asc" || dir === "desc") {
    state.filesSortDesc = dir === "desc";
  } else if (key === state.filesSortKey && dir !== "keep") {
    state.filesSortDesc = !state.filesSortDesc;
  } else {
    state.filesSortDesc = key === "modified" || key === "size";
  }
  state.filesSortKey = key;
  refreshFiles(state);
}

/** The sort menu's Ascending / Descending rows. */
export function setSortDir(state: FilesState, dir: unknown): void {
  if (dir !== "asc" && dir !== "desc") return;
  const desc = dir === "desc";
  state.showSortMenu = false;
  if (state.filesSortDesc === desc) return;
  state.filesSortDesc = desc;
  refreshFiles(state);
}

export function toggleSortMenu(state: FilesState): void {
  state.showSortMenu = !state.showSortMenu;
}

export function closeSortMenu(state: FilesState): void {
  if (state.showSortMenu) state.showSortMenu = false;
}

export async function uploadFiles(state: FilesState, context: GlobalContext): Promise<void> {
  if (state.filesBusy) return;
  // Captured before the await: the pick can take as long as the user likes.
  const drive = currentDrive();
  const folderId = state.folderId;
  state.filesBusy = true;
  state.showSortMenu = false;
  state.filesStatus = "Waiting for files…";
  try {
    const res = await context.device.request("file.pick", { accept: [], maxCount: 16 });
    if (!res.ok) {
      state.filesStatus = deviceMessage(res.error.code, "upload");
      return;
    }
    let used = drive.usedBytes();
    let saved = 0;
    const skipped: string[] = [];
    for (const item of res.value.items) {
      if (item.bytes.byteLength > MAX_FILE_BYTES || used + item.bytes.byteLength > MAX_DRIVE_BYTES) {
        skipped.push(item.name);
        continue;
      }
      if (await drive.putFile(folderId, item.name, item.contentType, item.bytes)) {
        used += item.bytes.byteLength;
        saved++;
      }
    }
    state.filesStatus =
      skipped.length > 0
        ? `Uploaded ${saved}; ${skipped.length} skipped (over the size limit or quota).`
        : `Uploaded ${saved} file${saved === 1 ? "" : "s"}.`;
  } finally {
    state.filesBusy = false;
    refreshFiles(state);
  }
}

export async function downloadFile(state: FilesState, context: GlobalContext, id: unknown): Promise<void> {
  if (typeof id !== "string" || state.filesBusy) return;
  const file = await currentDrive().readFile(id);
  if (!file) return;
  if (file.bytes.byteLength === 0) {
    state.filesStatus = "That file is empty.";
    return;
  }
  // An image is saved as what it really is; anything else keeps its type.
  const contentType = sniffImageType(file.bytes) ?? file.node.contentType ?? "application/octet-stream";
  state.filesBusy = true;
  state.filesStatus = `Saving ${file.node.name}…`;
  try {
    const res = await context.device.save(file.bytes, { name: file.node.name, contentType });
    state.filesStatus = res.ok ? `Saved ${file.node.name}.` : deviceMessage(res.error.code, "save");
  } finally {
    state.filesBusy = false;
  }
}

export async function deleteEntry(state: FilesState, id: unknown): Promise<void> {
  if (typeof id !== "string") return;
  const drive = currentDrive();
  const node = drive.get(id);
  if (!node) return;
  await drive.remove(id);
  state.filesStatus = `Deleted ${node.name}.`;
  if (state.selectedId === id) {
    state.selectedId = "";
    state.renaming = false;
  }
  refreshFiles(state);
}

export function toggleNewFolder(state: FilesState): void {
  state.showNewFolder = !state.showNewFolder;
  state.showSortMenu = false;
  state.newFolderName = "";
}

export function createFolder(state: FilesState): void {
  const name = state.newFolderName.trim();
  if (!name) return;
  const folder = currentDrive().createFolder(state.folderId, name);
  state.showNewFolder = false;
  state.newFolderName = "";
  state.filesStatus = folder ? "" : "Couldn't create that folder.";
  // Select the new folder, like Finder does.
  if (folder) state.selectedId = folder.id;
  refreshFiles(state);
}

export function startRename(state: FilesState): void {
  if (!state.selectedId) return;
  state.renameName = state.selection.name;
  state.renaming = true;
}

export function cancelRename(state: FilesState): void {
  state.renaming = false;
  state.renameName = "";
}

export function commitRename(state: FilesState): void {
  const id = state.selectedId;
  if (!id || !state.renaming) return;
  const raw = state.renameName.trim();
  state.renaming = false;
  state.renameName = "";
  if (!raw) return;
  const before = state.selection.name;
  const name = currentDrive().rename(id, raw);
  if (name) state.filesStatus = `Renamed ${before} to ${name}.`;
  refreshFiles(state);
}

/** In-app DnD: an item dropped onto a folder or a breadcrumb. */
export function moveInto(state: FilesState, payload: DndEventPayload | undefined): void {
  const item = payload?.item;
  const target = payload?.to?.zone;
  if (typeof item !== "string" || typeof target !== "string") return;
  const drive = currentDrive();
  const node = drive.get(item);
  if (!node) return;
  if (drive.move(item, target)) {
    const dest = drive.path(target).at(-1)?.name ?? "folder";
    state.filesStatus = `Moved ${node.name} to ${dest}.`;
  } else if (item === target || node.parentId !== target) {
    state.filesStatus = "Can't move a folder into itself.";
  }
  refreshFiles(state);
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

// Palette (dark, over the wallpaper — like the rest of the home screen).
const TEXT = "#F3F4F6";
const MUTED = "#9CA3AF";
const SELECT_ROW = "rgba(59, 130, 246, 0.42)";
const SELECT_NAME = "#2563EB";
const HOVER = "rgba(255, 255, 255, 0.06)";
const DROP_OVER = "rgba(147, 197, 253, 0.26)";

/** Shared drag-and-drop wiring for a tile or a row. */
const DND = `
                  .draggable(group: "fs")
                  .dropZone(group: "fs", id: "@{item.id}", enabled: @item.isFolder)
                  .onDrop(@actions.moveInto)
                  .states(transition: easeOut, duration: 120) {
                    onState(lifted).opacity(0.6).scale(1.03)
                    onState(over).backgroundColor("${DROP_OVER}")
                  }`;

/**
 * The kind icon at `size` px: the image itself, a folder, or a page with a
 * coloured extension badge (`badge` only on the large grid icon).
 */
function kindIcon(size: number, badge: boolean): string {
  const docBody = badge
    ? `
                        // Hypen has no CSS positioning: a Stack layers the
                        // badge over the page, padded into its lower left.
                        Stack {
                          Icon(@resources.doc-fill)
                            .size(${size})
                          If(condition: "@{item.ext != ''}") {
                            Column {
                              Row {
                                Text("@{item.ext}")
                                  .tw("text-[9px] font-bold tracking-wide leading-none")
                                  .color("#FFFFFF")
                              }
                              .backgroundColor("@{item.tint}")
                              .tw("rounded-[3px] px-[4px] py-[2.5px]")
                            }
                            .tw("w-[${size}px] h-[${size}px] justify-end items-start pb-[${Math.round(size * 0.22)}px] pl-[${Math.round(size * 0.12)}px]")
                          }
                        }
                        .tw("w-[${size}px] h-[${size}px] shrink-0")`
    : `
                        Icon(@resources.doc-fill)
                          .size(${size})`;
  return `
                      If(condition: "@{item.isImage}") {
                        Image(src: "@{item.previewUrl}")
                          .objectFit("cover")
                          .tw("w-[${size}px] h-[${size}px] rounded-${size > 40 ? "lg" : "[5px]"} shrink-0 bg-white/10 border border-white/10")
                      }
                      If(condition: "@{item.isFolder}") {
                        Icon(@resources.folder-fill)
                          .size(${size})
                      }
                      If(condition: "@{!item.isFolder && !item.isImage}") {${docBody}
                      }`;
}

/** A toolbar icon button. */
function toolButton(icon: string, action: string, extra = ""): string {
  return `
                    Button {
                      Icon(@resources.${icon})
                        .size(18)
                        .color("${TEXT}")
                    }
                    .onClick(${action})
                    .opacity({ default: 1, active: 0.6 })
                    .tw("bg-transparent hover:bg-white/10 border-0 rounded-lg w-9 h-9 p-0 items-center justify-center shrink-0 ${extra}")`;
}

function sortMenuRow(key: SortKey): string {
  return `
                          Button {
                            Row {
                              Icon(@resources.check)
                                .size(15)
                                .color("@{state.accent}")
                                .opacity("@{state.filesSortKey == '${key}' ? 1 : 0}")
                              Text("${SORT_LABELS[key]}")
                                .tw("ml-2 text-[13px]")
                                .color("${TEXT}")
                            }
                            .tw("items-center")
                          }
                          .onClick(@actions.setSort, key: "${key}", dir: "keep")
                          .tw("bg-transparent hover:bg-white/10 border-0 rounded-md px-2 py-1.5 w-full justify-start")`;
}

function sortDirRow(dir: "asc" | "desc", label: string): string {
  const on = dir === "desc" ? "state.filesSortDesc" : "!state.filesSortDesc";
  return `
                          Button {
                            Row {
                              Icon(@resources.check)
                                .size(15)
                                .color("@{state.accent}")
                                .opacity("@{${on} ? 1 : 0}")
                              Text("${label}")
                                .tw("ml-2 text-[13px]")
                                .color("${TEXT}")
                            }
                            .tw("items-center")
                          }
                          .onClick(@actions.setSortDir, dir: "${dir}")
                          .tw("bg-transparent hover:bg-white/10 border-0 rounded-md px-2 py-1.5 w-full justify-start")`;
}

/** A clickable list-column header. */
function columnHeader(key: SortKey, label: string, tw: string, align = "left"): string {
  return `
                      Button {
                        Text("${label}@{state.filesSortArrows.${key}}")
                          .tw("w-full text-${align} text-[11.5px] font-semibold whitespace-nowrap")
                          .color("@{state.filesSortKey == '${key}' ? '${TEXT}' : '${MUTED}'}")
                      }
                      .onClick(@actions.setSort, key: "${key}")
                      .tw("bg-transparent hover:bg-white/5 border-0 rounded-md px-1.5 py-1 ${tw}")`;
}

function detailButton(icon: string, label: string, action: string, color = TEXT, display = ""): string {
  return `
                      Button {
                        Row {
                          Icon(@resources.${icon})
                            .size(15)
                            .color("${color}")
                          Text("${label}")
                            .tw("ml-1.5 text-[13px] font-medium")
                            .color("${color}")
                        }
                        .tw("items-center")
                      }
                      .onClick(${action})
                      .opacity({ default: 1, active: 0.6 })${display ? `
                      .display("${display}")` : ""}
                      .tw("bg-white/10 hover:bg-white/15 border-0 rounded-lg px-3 py-1.5 shrink-0")`;
}

/** The `/files` route. `wallpaper` is the shared wallpaper applicator. */
export function filesRoute(wallpaper: string): string {
  return `
        Route(path: "/files") {
          Column {
            SafeArea {
              // ----- Title -----
              Column {
                Button {
                  Row {
                    Icon(@resources.chevron-left)
                      .size(20)
                      .color("@{state.accent}")
                    Text("Home")
                      .tw("text-[17px] font-medium")
                      .color("@{state.accent}")
                  }
                  .tw("items-center")
                }
                .onClick(@router.push, to: "/")
                .opacity({ default: 1, active: 0.6 })
                .transition(140, easeOut)
                .tw("bg-transparent border-0 px-0 py-2")

                Row {
                  Text("Files")
                    .tw("text-[34px] font-bold")
                    .color("#F9FAFB")
                  Column {}
                    .tw("flex-1")
                  Text("@{state.driveUsage}")
                    .tw("text-xs pb-2")
                    .color("${MUTED}")
                }
                .tw("w-full items-end mt-1")
              }
              .tw("px-1 pt-3 pb-3 w-full items-start")

              // ----- Browser window -----
              // A Stack so the sort menu can float over the window (Hypen
              // has no CSS positioning).
              Stack {
              Column {
                // Toolbar row 1: up, path, new folder, upload.
                Row {
                  Button {
                    Icon(@resources.chevron-left)
                      .size(18)
                      .color("${TEXT}")
                  }
                  .onClick(@actions.openParent)
                  .opacity("@{state.folderId == 'root' ? 0.3 : 1}")
                  .tw("bg-transparent hover:bg-white/10 border-0 rounded-lg w-9 h-9 p-0 items-center justify-center shrink-0")

                  // Breadcrumbs — each one is a drop target, so an item can
                  // be dragged back up to any ancestor folder.
                  Row {
                    ForEach(items: @state.crumbs, key: "id") {
                      Row {
                        Button {
                          Text("@{item.name}")
                            .tw("text-[14px] whitespace-nowrap")
                            .fontWeight("@{item.isLast ? 600 : 400}")
                            .color("@{item.isLast ? '${TEXT}' : '${MUTED}'}")
                        }
                        .onClick(@actions.openEntry, id: "@{item.id}")
                        .dropZone(group: "fs", id: "@{item.id}")
                        .onDrop(@actions.moveInto)
                        .states(transition: easeOut, duration: 120) { onState(over).backgroundColor("${DROP_OVER}") }
                        .tw("bg-transparent hover:bg-white/10 border-0 rounded-md px-1.5 py-1 shrink-0")
                        If(condition: "@{!item.isLast}") {
                          Icon(@resources.chevron-right)
                            .size(14)
                            .color("#6B7280")
                        }
                      }
                      .tw("items-center shrink-0")
                    }
                  }
                  .tw("flex-1 min-w-0 items-center overflow-x-auto ml-1")

                  ${toolButton("folder-plus", "@actions.toggleNewFolder", "ml-1")}

                  Button {
                    Row {
                      Icon(@resources.upload)
                        .size(16)
                        .color("#0B1020")
                      Text("Upload")
                        .tw("ml-1.5 text-[13px] font-semibold hidden sm:block")
                        .color("#0B1020")
                    }
                    .tw("items-center")
                  }
                  .onClick(@actions.uploadFiles)
                  .opacity({ default: 1, active: 0.7 })
                  .backgroundColor("@{state.accent}")
                  .tw("border-0 rounded-lg h-9 px-3 ml-1.5 shrink-0 items-center justify-center")
                }
                .tw("w-full items-center px-2 pt-2 pb-1.5")

                // Toolbar row 2: count, sort, view toggle.
                Row {
                  Text("@{state.filesCount}")
                    .tw("text-xs flex-1 min-w-0 truncate pl-1.5")
                    .color("${MUTED}")

                  // Sort control (its menu is layered over the window below).
                  Column {
                    Button {
                      Row {
                        Icon(@resources.sort)
                          .size(14)
                          .color("${TEXT}")
                        Text("@{state.filesSortLabel} @{state.filesSortArrow}")
                          .tw("ml-1.5 text-[12.5px] font-medium whitespace-nowrap")
                          .color("${TEXT}")
                      }
                      .tw("items-center")
                    }
                    .onClick(@actions.toggleSortMenu)
                    .backgroundColor("@{state.showSortMenu ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)'}")
                    .tw("hover:bg-white/15 border-0 rounded-lg h-8 px-2.5 items-center justify-center")

                  }
                  .tw("shrink-0")

                  // Grid ↔ list.
                  Row {
                    Button {
                      Icon(@resources.view-grid)
                        .size(16)
                        .color("@{state.filesView == 'grid' ? '${TEXT}' : '${MUTED}'}")
                    }
                    .onClick(@actions.setView, view: "grid")
                    .backgroundColor("@{state.filesView == 'grid' ? 'rgba(255,255,255,0.18)' : 'transparent'}")
                    .tw("border-0 rounded-md w-8 h-7 p-0 items-center justify-center")
                    Button {
                      Icon(@resources.view-list)
                        .size(16)
                        .color("@{state.filesView == 'list' ? '${TEXT}' : '${MUTED}'}")
                    }
                    .onClick(@actions.setView, view: "list")
                    .backgroundColor("@{state.filesView == 'list' ? 'rgba(255,255,255,0.18)' : 'transparent'}")
                    .tw("border-0 rounded-md w-8 h-7 p-0 items-center justify-center")
                  }
                  .tw("ml-2 p-0.5 rounded-lg bg-white/[0.08] items-center shrink-0")
                }
                .tw("w-full items-center px-3 pb-2.5 border-b border-white/[0.07]")

                If(condition: "@{state.showNewFolder}") {
                  Row {
                    Icon(@resources.folder-fill)
                      .size(22)
                    Input(placeholder: "New folder name")
                      .bind(@state.newFolderName)
                      .onKey(@actions.createFolder)
                      .tw("flex-1 min-w-0 ml-2 rounded-lg px-3 py-1.5 text-sm border border-white/10")
                      .backgroundColor("rgba(0, 0, 0, 0.35)")
                      .color("#F9FAFB")
                    Button {
                      Text("Create")
                        .tw("text-[13px] font-semibold")
                        .color("#0B1020")
                    }
                    .onClick(@actions.createFolder)
                    .backgroundColor("@{state.accent}")
                    .tw("border-0 rounded-lg px-3 py-1.5 ml-2 shrink-0")
                    ${toolButton("x", "@actions.toggleNewFolder", "ml-1")}
                  }
                  .tw("px-3 py-2 w-full items-center border-b border-white/[0.07]")
                  .enter(fade, duration: 160)
                }

                If(condition: "@{state.filesStatus != ''}") {
                  Text("@{state.filesStatus}")
                    .tw("px-4 py-2 text-xs w-full border-b border-white/[0.07]")
                    .color("#D1D5DB")
                }

                // ----- Contents -----
                Column {
                  If(condition: "@{state.filesEmpty}") {
                    Column {
                      Icon(@resources.folder-fill)
                        .size(64)
                        .opacity(0.55)
                      Text("This folder is empty")
                        .tw("mt-3 text-[15px] font-semibold")
                        .color("${TEXT}")
                      Text("Drop files here or click Upload. Up to ${formatBytes(MAX_FILE_BYTES)} per upload.")
                        .tw("mt-1 text-xs text-center max-w-[260px] self-center")
                        .color("${MUTED}")
                    }
                    .tw("w-full flex-1 items-center justify-center py-16 px-6")
                  }

                  If(condition: "@{!state.filesEmpty && state.filesView == 'grid'}") {
                    Grid(@state.entries, key: "id") {
                      Column {
                        Column {${kindIcon(64, true)}
                        }
                        .backgroundColor("@{item.selected ? 'rgba(255,255,255,0.12)' : 'transparent'}")
                        .tw("w-[84px] h-[80px] rounded-xl items-center justify-center")

                        Text("@{item.name}")
                          .backgroundColor("@{item.selected ? '${SELECT_NAME}' : 'transparent'}")
                          .tw("mt-1 px-1.5 py-[1px] rounded-[5px] text-[12px] leading-[1.3] text-center line-clamp-2 break-words max-w-full")
                          .color("${TEXT}")
                      }
                      .onClick(@actions.tapEntry, id: "@{item.id}")
                      .backgroundColor({ default: "transparent", hover: "${HOVER}" })
                      .tw("items-center px-1 pt-1.5 pb-2 rounded-xl cursor-pointer select-none")${DND}
                    }
                    .gridColumns(4)
                    .tw("w-full gap-1 p-3")
                  }

                  If(condition: "@{!state.filesEmpty && state.filesView == 'list'}") {
                    Column {
                      // Column headers — click to sort, again to flip.
                      Row {
                        ${columnHeader("name", "Name", "flex-1 min-w-0 text-left justify-start pl-[38px]")}
                        ${columnHeader("kind", "Kind", "w-[150px] shrink-0 justify-start hidden md:flex")}
                        ${columnHeader("size", "Size", "w-[88px] shrink-0 hidden sm:flex", "right")}
                        ${columnHeader("modified", "Date Modified", "w-[200px] shrink-0 justify-start ml-3 hidden md:flex")}
                      }
                      .tw("w-full items-center px-2 py-1 border-b border-white/[0.07]")

                      ForEach(items: @state.entries, key: "id") {
                        Row {
                          Row {${kindIcon(28, false)}
                          }
                          .tw("w-[28px] h-[28px] items-center justify-center shrink-0")

                          Column {
                            Text("@{item.name}")
                              .tw("text-[13.5px] w-full truncate text-left")
                              .color("${TEXT}")
                            Text("@{item.detail}")
                              .tw("text-[11.5px] mt-0.5 text-left block md:hidden")
                              .color("@{item.selected ? '#DBEAFE' : '${MUTED}'}")
                          }
                          .tw("flex-1 min-w-0 ml-2.5 items-start")

                          Text("@{item.kind}")
                            .tw("w-[150px] shrink-0 px-1.5 text-[12.5px] truncate hidden md:block")
                            .color("@{item.selected ? '#DBEAFE' : '${MUTED}'}")
                          Text("@{item.size}")
                            .tw("w-[88px] shrink-0 self-center px-1.5 text-[12.5px] text-right tabular-nums whitespace-nowrap hidden sm:block")
                            .color("@{item.selected ? '#DBEAFE' : '${MUTED}'}")
                          Text("@{item.modified}")
                            .tw("w-[200px] shrink-0 ml-3 px-1.5 text-[12.5px] truncate hidden md:block")
                            .color("@{item.selected ? '#DBEAFE' : '${MUTED}'}")
                        }
                        .onClick(@actions.tapEntry, id: "@{item.id}")
                        .backgroundColor({ default: "@{item.selected ? '${SELECT_ROW}' : 'transparent'}", hover: "@{item.selected ? '${SELECT_ROW}' : '${HOVER}'}" })
                        .tw("w-full items-center px-2 py-1.5 min-h-[40px] rounded-lg cursor-pointer select-none")${DND}
                      }
                    }
                    .tw("w-full p-1.5")
                  }
                }
                .tw("w-full flex-1 min-h-[300px] overflow-y-auto")
                // Files dragged in from the OS light the pane up and ask for a
                // pick; the host dialog takes the drop. Its own group keeps the
                // in-app "fs" drags from highlighting it.
                .dropZone(group: "os-files", files: true)
                .onFileDragEnter(@actions.uploadFiles)
                .states { onState(over).backgroundColor("rgba(96,165,250,0.10)") }

                // ----- Details bar for the selection -----
                If(condition: "@{state.selectedId != ''}") {
                  Row {
                    Row {
                      Row {
                        If(condition: "@{state.selection.isImage}") {
                          Image(src: "@{state.selection.previewUrl}")
                            .objectFit("cover")
                            .tw("w-[40px] h-[40px] rounded-md bg-white/10")
                        }
                        If(condition: "@{state.selection.isFolder}") {
                          Icon(@resources.folder-fill)
                            .size(40)
                        }
                        If(condition: "@{!state.selection.isFolder && !state.selection.isImage}") {
                          Icon(@resources.doc-fill)
                            .size(40)
                        }
                      }
                      .tw("w-[40px] h-[40px] items-center justify-center shrink-0")

                      // Flat, complementary Ifs (no nested branches) keep
                      // each slot's reconciliation simple.
                      If(condition: "@{state.renaming}") {
                        Input(placeholder: "Name")
                          .bind(@state.renameName)
                          .onKey(@actions.commitRename)
                          .tw("flex-1 min-w-0 ml-3 rounded-lg px-3 py-1.5 text-sm border border-white/15")
                          .backgroundColor("rgba(0, 0, 0, 0.35)")
                          .color("#F9FAFB")
                      }
                      If(condition: "@{!state.renaming}") {
                        Column {
                          Text("@{state.selection.name}")
                            .tw("text-[14px] font-semibold w-full truncate text-left")
                            .color("${TEXT}")
                          Text("@{state.selection.kind} · @{state.selection.size} · @{state.selection.modified}")
                            .tw("text-[11.5px] mt-0.5 w-full truncate text-left")
                            .color("${MUTED}")
                        }
                        .tw("flex-1 min-w-0 ml-3 items-start")
                      }
                    }
                    .tw("flex-1 min-w-[220px] items-center")

                    Row {
                      If(condition: "@{state.renaming}") {${detailButton("check", "Save", "@actions.commitRename")}${detailButton("x", "Cancel", "@actions.cancelRename")}
                      }
                      If(condition: "@{!state.renaming}") {
                        // Open (folders) / Download (files) both stay mounted
                        // and swap by display, so the button order is stable.${detailButton("folder", "Open", '@actions.openEntry, id: "@{state.selectedId}"', TEXT, "@{state.selection.isFolder ? 'flex' : 'none'}")}${detailButton("download", "Download", '@actions.downloadFile, id: "@{state.selectedId}"', TEXT, "@{state.selection.isFolder ? 'none' : 'flex'}")}${detailButton("pencil", "Rename", "@actions.startRename")}${detailButton("trash", "Delete", '@actions.deleteEntry, id: "@{state.selectedId}"', "#FCA5A5")}
                        ${toolButton("x", "@actions.clearSelection")}
                      }
                    }
                    .tw("gap-1.5 items-center ml-auto")
                  }
                  .tw("w-full items-center flex-wrap gap-x-3 gap-y-2 px-3 py-2.5 border-t border-white/[0.07]")
                  .backgroundColor("rgba(255, 255, 255, 0.04)")
                  .enter(fade, duration: 140)
                }
              }
              .tw("w-full min-h-[460px] rounded-2xl border border-white/10 shadow-2xl")
              .backgroundColor("rgba(17, 19, 26, 0.74)")
              .backdropFilter("blur(28px)")

              If(condition: "@{state.showSortMenu}") {
                // Click-away layer; the menu sits under the Sort button.
                Column {
                  Column {
                    Text("Sort By")
                      .tw("text-[11px] font-semibold px-2 pt-1 pb-1")
                      .color("${MUTED}")
${SORT_KEYS.map(sortMenuRow).join("")}
                    Column {}
                      .tw("h-px w-full my-1 bg-white/10")
${sortDirRow("asc", "Ascending")}
${sortDirRow("desc", "Descending")}
                  }
                  .tw("w-[190px] p-1.5 rounded-xl border border-white/10 shadow-2xl")
                  .backgroundColor("rgba(30, 33, 42, 0.97)")
                  .backdropFilter("blur(24px)")
                  .enter(fade, duration: 120)
                }
                .onClick(@actions.closeSortMenu)
                .tw("w-full self-stretch items-end pt-[94px] pr-[86px]")
              }
              }
              .tw("w-full")
            }
            .tw("flex-1 w-full max-w-[1000px] px-3 sm:px-5 items-center overflow-auto pb-8")
          }
          ${wallpaper}
          .tw("flex-1 min-h-screen w-full items-center")
        }`;
}
