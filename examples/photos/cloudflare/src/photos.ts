import { app } from "@hypen-space/core";
import type { DndEventPayload, GlobalContext } from "@hypen-space/core";
import {
  MAX_LIBRARY_BYTES,
  MAX_PHOTO_BYTES,
  currentLibrary,
  sniffImageType,
  type Library,
  type Photo,
  type PhotoSource,
} from "./library";
import { reverseGeocode } from "./geocode";

// Photos — a camera roll and photo library for the Hypen home screen.
//
// Bytes only ever move through the device plane (RFC 001):
//
// - Capture: `camera.capture`. The visitor's DeviceHost opens its own camera
//   dialog (live preview + shutter) and returns one JPEG.
// - Import: `gallery.pick` (the host's photo picker) and `file.pick` (any
//   image file). Dragging image files from the desktop over the library
//   lights it up (`.dropZone(files: true)`) and `.onFileDragEnter` asks for a
//   `file.pick` right away — the host dialog pops up under the held drag and
//   takes the drop. The browser itself never hands file data to the page.
// - Download: `file.save`. The host asks for consent and a destination.
//
// Metadata (EXIF date, camera, GPS) is read server-side (exif.ts) and GPS
// positions are reverse-geocoded through Nominatim (geocode.ts). Everything
// lives in the visitor's own Durable Object: SQLite rows + R2 bytes
// (library.ts).
//
// Inside the library, photos are ordinary Hypen drag-and-drop: every tile is
// `.draggable(group: "photos")` and each album chip is a `.dropZone` —
// dropping a photo files it into that album (or Favorites).

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface Tile {
  id: string;
  url: string;
  fav: boolean;
  /** False for HEIC (stored, downloadable, but not displayable in browsers). */
  showable: boolean;
}

export interface Section {
  /** "2026-11-12" */
  id: string;
  /** "Today", "Yesterday", "Tuesday, Nov 10", "Mar 3, 2024". */
  title: string;
  /** "Lisbon, Portugal · 4 photos" */
  subtitle: string;
  photos: Tile[];
}

export interface AlbumCard {
  id: string;
  name: string;
  countLabel: string;
  coverUrl: string;
  hasCover: boolean;
}

export interface PickerRow {
  id: string;
  name: string;
  checked: boolean;
}

export type ViewerContext = "library" | "favorites" | "album";

export interface Viewer {
  id: string;
  url: string;
  showable: boolean;
  fav: boolean;
  /** "Today", "Nov 12, 2026" */
  title: string;
  /** "14:30 · Lisbon, Portugal" */
  subtitle: string;
  /** "3 of 12" */
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  // Info panel
  dateLine: string;
  dateNote: string;
  camera: string;
  hasCamera: boolean;
  exposure: string;
  hasExposure: boolean;
  fileLine: string;
  hasGps: boolean;
  place: string;
  coords: string;
  albumsLine: string;
}

export interface PhotosState {
  /** The Router's binding. */
  location: string;
  sections: Section[];
  favSections: Section[];
  albumSections: Section[];
  libraryEmpty: boolean;
  favEmpty: boolean;
  albumEmpty: boolean;
  /** "128 photos · 3 albums" */
  summary: string;
  favSummary: string;
  usage: string;

  albums: AlbumCard[];
  albumsEmpty: boolean;
  album: { id: string; name: string; countLabel: string };
  showNewAlbum: boolean;
  newAlbumName: string;
  confirmDeleteAlbum: boolean;

  viewer: Viewer;
  viewerContext: ViewerContext;
  showInfo: boolean;
  showAlbumPicker: boolean;
  pickerAlbums: PickerRow[];
  pickerNewName: string;
  confirmDelete: boolean;
  /** Shared-element mark: the tile that flies into (or back out of) the viewer. */
  openingId: string;
  /** Swipe poses written by the viewer's `.scrub/.settle` ("center" at rest). */
  swipeNext: string;
  swipePrev: string;

  status: string;
  busy: boolean;
}

const BLANK_VIEWER: Viewer = {
  id: "",
  url: "",
  showable: false,
  fav: false,
  title: "",
  subtitle: "",
  position: "",
  hasPrev: false,
  hasNext: false,
  dateLine: "",
  dateNote: "",
  camera: "",
  hasCamera: false,
  exposure: "",
  hasExposure: false,
  fileLine: "",
  hasGps: false,
  place: "",
  coords: "",
  albumsLine: "",
};

export function initialState(): PhotosState {
  return {
    location: "/",
    sections: [],
    favSections: [],
    albumSections: [],
    libraryEmpty: true,
    favEmpty: true,
    albumEmpty: true,
    summary: "",
    favSummary: "",
    usage: "",
    albums: [],
    albumsEmpty: true,
    album: { id: "", name: "", countLabel: "" },
    showNewAlbum: false,
    newAlbumName: "",
    confirmDeleteAlbum: false,
    viewer: { ...BLANK_VIEWER },
    viewerContext: "library",
    showInfo: false,
    showAlbumPicker: false,
    pickerAlbums: [],
    pickerNewName: "",
    confirmDelete: false,
    openingId: "",
    swipeNext: "center",
    swipePrev: "center",
    status: "",
    busy: false,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** A wall-clock "YYYY-MM-DDTHH:MM:SS" as a Date whose UTC fields are that wall clock. */
function wallDate(wall: string): Date {
  const [d = "1970-01-01", t = "00:00:00"] = wall.split("T");
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi, s] = t.split(":").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, da, h, mi, s));
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const WEEKDAY_DATE = fmt({ weekday: "long", month: "short", day: "numeric" });
const MONTH_DAY = fmt({ month: "short", day: "numeric" });
const FULL_DATE = fmt({ month: "short", day: "numeric", year: "numeric" });
const LONG_DATE = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
const TIME = fmt({ hour: "numeric", minute: "2-digit" });

/** Section/viewer title for a day ("2026-11-12") relative to `today`. */
export function dayTitle(day: string, today: string): string {
  if (day === today) return "Today";
  const d = wallDate(`${day}T00:00:00`);
  const t = wallDate(`${today}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return WEEKDAY_DATE.format(d);
  if (day.slice(0, 4) === today.slice(0, 4)) return MONTH_DAY.format(d);
  return FULL_DATE.format(d);
}

function cameraName(p: Photo): string {
  const make = p.make.trim();
  const model = p.model.trim();
  if (!model) return make;
  // "Apple" + "iPhone 15 Pro", but not "Canon" + "Canon EOS R6".
  return make && !model.toLowerCase().startsWith(make.toLowerCase().split(" ")[0]!) ? `${make} ${model}` : model;
}

function kindLabel(type: string): string {
  return type.replace(/^image\//, "").replace("jpeg", "JPEG").replace("png", "PNG").replace("webp", "WebP")
    .replace("gif", "GIF").replace("avif", "AVIF").replace("heic", "HEIC");
}

function tile(lib: Library, p: Photo): Tile {
  return { id: p.id, url: lib.url(p.id), fav: p.favorite, showable: p.contentType !== "image/heic" };
}

/** Group photos (already newest first) by local day. */
function sectionsOf(lib: Library, photos: Photo[], today: string): Section[] {
  const out: Section[] = [];
  const places = new Map<string, Set<string>>();
  for (const p of photos) {
    const day = p.takenAt.slice(0, 10);
    let section = out[out.length - 1];
    if (!section || section.id !== day) {
      section = { id: day, title: dayTitle(day, today), subtitle: "", photos: [] };
      out.push(section);
      places.set(day, new Set());
    }
    section.photos.push(tile(lib, p));
    if (p.place) places.get(day)!.add(p.place);
  }
  for (const s of out) {
    const where = [...(places.get(s.id) ?? [])];
    const placeText = where.length > 2 ? `${where.slice(0, 2).join(" & ")} +${where.length - 2}` : where.join(" & ");
    s.subtitle = [placeText, plural(s.photos.length, "photo")].filter(Boolean).join(" · ");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function refreshLibrary(state: PhotosState): void {
  const lib = currentLibrary();
  const today = wallToday(lib);
  const all = lib.list();
  const favs = all.filter((p) => p.favorite);
  const albums = lib.albums();

  state.sections = sectionsOf(lib, all, today);
  state.favSections = sectionsOf(lib, favs, today);
  state.libraryEmpty = all.length === 0;
  state.favEmpty = favs.length === 0;
  state.summary = all.length
    ? [plural(all.length, "photo"), albums.length ? plural(albums.length, "album") : ""].filter(Boolean).join(" · ")
    : "No photos yet";
  state.favSummary = favs.length ? plural(favs.length, "favorite") : "No favorites yet";
  state.usage = `${formatBytes(lib.usedBytes())} of ${formatBytes(MAX_LIBRARY_BYTES)}`;

  state.albums = albums.map((a) => ({
    id: a.id,
    name: a.name,
    countLabel: plural(a.count, "photo"),
    coverUrl: a.coverId ? lib.url(a.coverId) : "",
    hasCover: a.coverId !== "",
  }));
  state.albumsEmpty = albums.length === 0;

  if (state.album.id) {
    const album = albums.find((a) => a.id === state.album.id);
    if (album) {
      state.album = { id: album.id, name: album.name, countLabel: plural(album.count, "photo") };
      const photos = lib.inAlbum(album.id);
      state.albumSections = sectionsOf(lib, photos, today);
      state.albumEmpty = photos.length === 0;
    } else {
      state.album = { id: "", name: "", countLabel: "" };
      state.albumSections = [];
      state.albumEmpty = true;
    }
  }
}

/** "YYYY-MM-DD" today in the visitor's time zone. */
function wallToday(lib: Library): string {
  return wallClockDay(Date.now(), lib.timeZone);
}

function wallClockDay(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(ms),
    );
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** The ordered photo ids the viewer pages through. */
function contextPhotos(lib: Library, state: PhotosState): Photo[] {
  if (state.viewerContext === "favorites") return lib.favorites();
  if (state.viewerContext === "album" && state.album.id) return lib.inAlbum(state.album.id);
  return lib.list();
}

/** Fill `state.viewer` for photo `id` (blank when it no longer exists). */
function loadViewer(state: PhotosState, id: string): void {
  const lib = currentLibrary();
  const photo = lib.get(id);
  if (!photo) {
    state.viewer = { ...BLANK_VIEWER };
    return;
  }
  const list = contextPhotos(lib, state);
  const index = list.findIndex((p) => p.id === id);
  const today = wallToday(lib);
  const when = wallDate(photo.takenAt);
  const day = photo.takenAt.slice(0, 10);
  const place = photo.place;
  const albumNames = lib.albums().filter((a) => lib.albumIdsOf(id).has(a.id)).map((a) => a.name);
  const exposure = [photo.aperture, photo.exposure, photo.iso ? `ISO ${photo.iso}` : "", photo.focalLength]
    .filter(Boolean)
    .join(" · ");
  const camera = cameraName(photo);
  const dims = photo.width && photo.height ? `${photo.width} × ${photo.height}` : "";
  const sourceLabel = photo.source === "camera" ? "Camera" : photo.source === "gallery" ? "Photo library" : "File";

  state.viewer = {
    id,
    url: lib.url(id),
    showable: photo.contentType !== "image/heic",
    fav: photo.favorite,
    title: dayTitle(day, today) === "Today" || dayTitle(day, today) === "Yesterday"
      ? dayTitle(day, today)
      : FULL_DATE.format(when),
    subtitle: [TIME.format(when), place].filter(Boolean).join(" · "),
    position: index >= 0 ? `${index + 1} of ${list.length}` : "",
    hasPrev: index > 0,
    hasNext: index >= 0 && index < list.length - 1,
    dateLine: `${LONG_DATE.format(when)} at ${TIME.format(when)}`,
    dateNote: photo.takenFromExif
      ? "Date from the photo's EXIF data"
      : `No capture date in the file — shown at the time it was added`,
    camera: [camera, photo.lens && photo.lens !== camera ? photo.lens : ""].filter(Boolean).join(" — "),
    hasCamera: camera !== "" || photo.lens !== "",
    exposure,
    hasExposure: exposure !== "",
    fileLine: [kindLabel(photo.contentType), dims, formatBytes(photo.bytes), sourceLabel].filter(Boolean).join(" · "),
    hasGps: photo.lat !== null && photo.lon !== null,
    place: place || (photo.lat !== null ? "Looking up place…" : ""),
    coords:
      photo.lat !== null && photo.lon !== null
        ? `${photo.lat.toFixed(5)}, ${photo.lon.toFixed(5)}${photo.altitude !== null ? ` · ${photo.altitude} m` : ""}`
        : "",
    albumsLine: albumNames.length ? albumNames.join(", ") : "Not in an album",
  };
  if (photo.lat !== null && photo.lon !== null && !place) void geocodeOne(state, lib, photo);
}

/** Look up one photo's place in the background, then refresh what shows it. */
async function geocodeOne(state: PhotosState, lib: Library, photo: Photo): Promise<void> {
  if (photo.lat === null || photo.lon === null) return;
  const place = await reverseGeocode(photo.lat, photo.lon, lib);
  if (!place) {
    if (state.viewer.id === photo.id) state.viewer.place = "Place unavailable";
    return;
  }
  lib.setPlace(photo.id, place);
  if (state.viewer.id === photo.id) {
    state.viewer.place = place;
    state.viewer.subtitle = [state.viewer.subtitle.split(" · ")[0], place].filter(Boolean).join(" · ");
  }
}

/** Name places for freshly imported photos (one Nominatim request per second, cached). */
async function geocodePending(state: PhotosState, lib: Library): Promise<void> {
  let changed = false;
  for (const photo of lib.needingPlace()) {
    if (photo.lat === null || photo.lon === null) continue;
    const place = await reverseGeocode(photo.lat, photo.lon, lib);
    if (!place) continue;
    lib.setPlace(photo.id, place);
    changed = true;
  }
  if (changed) refreshLibrary(state);
}

function deviceMessage(code: string, what: string): string {
  switch (code) {
    case "cancelled":
    case "denied":
      return "";
    case "unsupported":
    case "unavailable":
      return `This device can't ${what}.`;
    case "throttled":
      return `Too much at once (max ${formatBytes(MAX_PHOTO_BYTES)} per photo), or a prompt is already open.`;
    case "timeout":
      return "Timed out.";
    case "connectionLost":
      return "Connection lost. Try again.";
    case "revoked":
      return "Permission was revoked.";
    default:
      return "Something went wrong.";
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Picked = { bytes: Uint8Array; name?: string };

/** Store picked/captured items; returns a status line. */
async function storeItems(state: PhotosState, lib: Library, items: Picked[], source: PhotoSource): Promise<string> {
  let used = lib.usedBytes();
  let saved = 0;
  let notImages = 0;
  let tooBig = 0;
  let firstId = "";
  for (const item of items) {
    const size = item.bytes.byteLength;
    if (size === 0) continue;
    if (size > MAX_PHOTO_BYTES || used + size > MAX_LIBRARY_BYTES) {
      tooBig++;
      continue;
    }
    const photo = await lib.add(item.bytes, source, item.name ?? "");
    if (!photo) {
      notImages++;
      continue;
    }
    if (!firstId) firstId = photo.id;
    used += size;
    saved++;
  }
  refreshLibrary(state);
  void geocodePending(state, lib);
  const parts: string[] = [];
  if (saved) parts.push(source === "camera" ? "Photo saved." : `Added ${plural(saved, "photo")}.`);
  if (notImages) parts.push(`${plural(notImages, "file")} skipped (not a photo).`);
  if (tooBig) parts.push(`${plural(tooBig, "photo")} skipped (too large or over quota).`);
  return parts.join(" ") || "Nothing added.";
}

async function capture(state: PhotosState, context: GlobalContext): Promise<void> {
  if (state.busy) return;
  const lib = currentLibrary(); // captured before the await: the user may take their time
  state.busy = true;
  state.status = "Opening camera…";
  try {
    const res = await context.device.request("camera.capture", { mode: "photo", facing: "back" });
    if (!res.ok) {
      state.status = deviceMessage(res.error.code, "take photos");
      return;
    }
    state.status = await storeItems(state, lib, res.value.items, "camera");
  } finally {
    state.busy = false;
  }
}

async function importGallery(state: PhotosState, context: GlobalContext): Promise<void> {
  if (state.busy) return;
  const lib = currentLibrary();
  state.busy = true;
  state.status = "Choose photos…";
  try {
    const res = await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 16 });
    if (!res.ok) {
      state.status = deviceMessage(res.error.code, "share photos");
      return;
    }
    state.status = await storeItems(state, lib, res.value.items, "gallery");
  } finally {
    state.busy = false;
  }
}

async function importFiles(state: PhotosState, context: GlobalContext): Promise<void> {
  if (state.busy) return;
  const lib = currentLibrary();
  state.busy = true;
  state.status = "Waiting for image files…";
  try {
    const res = await context.device.request("file.pick", {
      accept: ["image/*", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic"],
      maxCount: 16,
    });
    if (!res.ok) {
      state.status = deviceMessage(res.error.code, "send files here");
      return;
    }
    state.status = await storeItems(state, lib, res.value.items, "file");
  } finally {
    state.busy = false;
  }
}

async function download(state: PhotosState, context: GlobalContext): Promise<void> {
  const id = state.viewer.id;
  if (!id || state.busy) return;
  const file = await currentLibrary().read(id);
  if (!file) return;
  const type = sniffImageType(file.bytes) ?? file.photo.contentType;
  const ext = type === "image/jpeg" ? "jpg" : type.replace(/^image\//, "");
  const stamp = file.photo.takenAt.replace(/[-:]/g, "").replace("T", "_");
  const name = file.photo.originalName || `IMG_${stamp}.${ext}`;
  state.busy = true;
  state.status = `Saving ${name}…`;
  try {
    const res = await context.device.save(file.bytes, { name, contentType: type });
    state.status = res.ok ? `Saved ${name}.` : deviceMessage(res.error.code, "save files");
  } finally {
    state.busy = false;
  }
}

/**
 * Navigate. The Router renders from the `location` state binding, so a
 * handler navigates by writing it (`context.router` is not wired for this
 * single-module Durable Object app: its push left `location` unchanged).
 */
function navigate(state: PhotosState, _context: GlobalContext, path: string): void {
  state.location = path;
}

/** Let the pending state flush (its own patch batch) before the next write. */
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The viewer's swipe gestures are `.scrub/.settle` pairs whose release
 * writes "next"/"prev" into `swipeNext`/`swipePrev` through the `.bind`
 * channel. A bind write runs no handler, and the pose's
 * `.onAnimationComplete` does not fire for a pose the scrub already reached
 * (see README, "Known issues"), so while the viewer is open the module checks
 * for a settled swipe every 100 ms and pages.
 */
const swipeWatchers = new WeakMap<object, ReturnType<typeof setInterval>>();

function watchSwipes(state: PhotosState): void {
  if (swipeWatchers.has(state)) return;
  const timer = setInterval(() => {
    if (state.location !== "/photo") {
      stopSwipes(state);
      return;
    }
    if (state.swipeNext === "next") step(state, 1);
    else if (state.swipePrev === "prev") step(state, -1);
  }, 100);
  swipeWatchers.set(state, timer);
}

function stopSwipes(state: PhotosState): void {
  const timer = swipeWatchers.get(state);
  if (timer !== undefined) clearInterval(timer);
  swipeWatchers.delete(state);
}

async function openPhoto(state: PhotosState, context: GlobalContext, id: unknown, from: unknown): Promise<void> {
  if (typeof id !== "string") return;
  state.viewerContext = from === "favorites" || from === "album" ? from : "library";
  state.showInfo = false;
  state.showAlbumPicker = false;
  state.confirmDelete = false;
  state.swipeNext = "center";
  state.swipePrev = "center";
  loadViewer(state, id);
  if (!state.viewer.id) return;
  // Mark first, then navigate: the mark must render in its own batch before
  // the navigation batch, so the tapped tile is the shared element's source.
  state.openingId = id;
  await nextTurn();
  navigate(state, context, "/photo");
  watchSwipes(state);
}

async function closeViewer(state: PhotosState, context: GlobalContext): Promise<void> {
  // Coming back, the viewer's image flies into the tile of the photo shown last.
  state.openingId = state.viewer.id;
  state.showAlbumPicker = false;
  state.confirmDelete = false;
  stopSwipes(state);
  await nextTurn();
  const back = state.viewerContext === "favorites" ? "/favorites" : state.viewerContext === "album" ? "/album" : "/";
  navigate(state, context, back);
}

function step(state: PhotosState, delta: 1 | -1): void {
  const lib = currentLibrary();
  const list = contextPhotos(lib, state);
  const index = list.findIndex((p) => p.id === state.viewer.id);
  const next = list[index + delta];
  state.swipeNext = "center";
  state.swipePrev = "center";
  if (!next) return;
  state.confirmDelete = false;
  state.showAlbumPicker = false;
  loadViewer(state, next.id);
  state.openingId = next.id;
}

function toggleFavorite(state: PhotosState, id: unknown): void {
  const target = typeof id === "string" && id ? id : state.viewer.id;
  const lib = currentLibrary();
  const photo = lib.get(target);
  if (!photo) return;
  lib.setFavorite(target, !photo.favorite);
  if (state.viewer.id === target) state.viewer.fav = !photo.favorite;
  refreshLibrary(state);
}

async function deletePhoto(state: PhotosState, context: GlobalContext): Promise<void> {
  const id = state.viewer.id;
  if (!id) return;
  const lib = currentLibrary();
  const list = contextPhotos(lib, state);
  const index = list.findIndex((p) => p.id === id);
  const neighbour = list[index + 1] ?? list[index - 1];
  await lib.remove(id);
  state.confirmDelete = false;
  state.status = "Photo deleted.";
  refreshLibrary(state);
  if (neighbour) {
    loadViewer(state, neighbour.id);
    state.openingId = neighbour.id;
  } else {
    // That was the last photo here: back to where the viewer was opened from.
    state.openingId = "";
    stopSwipes(state);
    state.viewer = { ...BLANK_VIEWER };
    navigate(state, context, state.viewerContext === "favorites" ? "/favorites" : state.viewerContext === "album" ? "/album" : "/");
  }
}

/** A photo tile dropped onto an album chip (or the Favorites chip). */
function dropOnAlbum(state: PhotosState, payload: DndEventPayload | undefined): void {
  const photoId = payload?.item;
  const target = payload?.to?.zone;
  if (typeof photoId !== "string" || typeof target !== "string") return;
  const lib = currentLibrary();
  if (target === "favorites") {
    const photo = lib.get(photoId);
    if (!photo) return;
    if (!photo.favorite) lib.setFavorite(photoId, true);
    state.status = photo.favorite ? "Already a favorite." : "Added to Favorites.";
  } else {
    const album = lib.album(target);
    if (!album) return;
    state.status = lib.addToAlbum(target, photoId) ? `Added to ${album.name}.` : `Already in ${album.name}.`;
  }
  refreshLibrary(state);
}

/** Create (or reuse, by name) an album; returns its id, "" for an unusable name. */
function createAlbum(state: PhotosState, rawName: string, withPhoto = ""): string {
  const lib = currentLibrary();
  const album = lib.albumNamed(rawName) ?? lib.createAlbum(rawName);
  if (!album) return "";
  if (withPhoto) lib.addToAlbum(album.id, withPhoto);
  refreshLibrary(state);
  return album.id;
}

function openAlbum(state: PhotosState, context: GlobalContext, id: unknown): void {
  if (typeof id !== "string") return;
  state.album = { id, name: "", countLabel: "" };
  state.confirmDeleteAlbum = false;
  refreshLibrary(state);
  if (!state.album.id) return;
  navigate(state, context, "/album");
}

function loadPicker(state: PhotosState): void {
  const lib = currentLibrary();
  const inAlbums = lib.albumIdsOf(state.viewer.id);
  state.pickerAlbums = lib.albums().map((a) => ({ id: a.id, name: a.name, checked: inAlbums.has(a.id) }));
}

function togglePickerAlbum(state: PhotosState, albumId: unknown): void {
  if (typeof albumId !== "string" || !state.viewer.id) return;
  const lib = currentLibrary();
  if (lib.albumIdsOf(state.viewer.id).has(albumId)) lib.removeFromAlbum(albumId, state.viewer.id);
  else lib.addToAlbum(albumId, state.viewer.id);
  loadPicker(state);
  refreshLibrary(state);
  loadViewer(state, state.viewer.id);
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const BG = "#0A0A0C";
const SURFACE = "#16161A";
const TEXT = "#F5F5F7";
const MUTED = "#8E8E93";
const ACCENT = "#FFD60A";
const DROP_OVER = "rgba(255, 214, 10, 0.22)";

/** A round icon button. */
function iconButton(icon: string, action: string, label: string, extra = "", color = TEXT): string {
  return `
            Button {
              Icon(@resources.${icon}).size(20).color("${color}")
            }
            .label("${label}")
            .onClick(${action})
            .opacity({ default: 1, active: 0.6 })
            .tw("bg-white/10 hover:bg-white/15 border-0 rounded-full w-10 h-10 p-0 items-center justify-center shrink-0 ${extra}")`;
}

/** Big title + subtitle header for a tab. */
function header(title: string, subtitle: string, trailing = ""): string {
  return `
          Row {
            Column {
              Text("${title}")
                .tw("text-[30px] font-bold leading-tight")
                .color("${TEXT}")
              Text("${subtitle}")
                .tw("text-[13px] mt-0.5")
                .color("${MUTED}")
            }
            .tw("flex-1 min-w-0 items-start")
            ${trailing}
          }
          .tw("w-full items-end px-4 pt-4 pb-2 gap-2")`;
}

/**
 * The day-grouped photo grid. `sections` is the state list, `from` the
 * viewer context a tap opens with.
 */
function photoGrid(sections: string, from: string): string {
  return `
            ForEach(items: @state.${sections}, key: "id", as: "section") {
              Column {
                Row {
                  Text("@{section.title}")
                    .tw("text-[17px] font-semibold")
                    .color("${TEXT}")
                  Text("@{section.subtitle}")
                    .tw("text-[12px] ml-2 truncate min-w-0")
                    .color("${MUTED}")
                }
                .tw("w-full items-baseline px-4 pt-4 pb-2")

                Grid(@section.photos, key: "id", as: "photo") {
                  Stack {
                    If(condition: "@{photo.showable}") {
                      Image(src: "@{photo.url}", alt: "Photo from @{section.title}")
                        .objectFit("cover")
                        .tw("w-full h-full")
                        .backgroundColor("${SURFACE}")
                        // An <img> starts the browser's native image drag,
                        // which swallows Hypen's pointer drag: let pointer
                        // events land on the draggable tile instead.
                        .pointerEvents("none")
                        .sharedElement("@{photo.id == state.openingId ? 'photo-hero' : ''}", curve: spring, duration: 320)
                    }
                    If(condition: "@{!photo.showable}") {
                      Column {
                        Icon(@resources.file-image).size(26).color("${MUTED}")
                        Text("HEIC").tw("text-[10px] mt-1 font-semibold").color("${MUTED}")
                      }
                      .tw("w-full h-full items-center justify-center")
                      .backgroundColor("${SURFACE}")
                    }
                    If(condition: "@{photo.fav}") {
                      Icon(@resources.heart-fill)
                        .size(16)
                        .color("#FFFFFF")
                        .tw("m-1.5 drop-shadow")
                    }
                  }
                  .horizontalAlignment("start")
                  .verticalAlignment("end")
                  .aspectRatio(1)
                  .tw("w-full overflow-hidden cursor-pointer select-none")
                  .onClick(@actions.openPhoto, id: "@{photo.id}", from: "${from}")
                  .draggable()
                  .states(transition: easeOut, duration: 120) {
                    onState(lifted).opacity(0.55).scale(0.92)
                  }
                }
                .gridColumns({ default: 3, sm: 4, md: 5, lg: 6 })
                // A loose .draggable gets touch-action:none, which would make
                // the grid unscrollable on phones. Inside a y-axis sortable the
                // tiles get pan-y instead: vertical swipes scroll, a sideways
                // move lifts the photo. There is no .bind/.onSort, so a drop
                // back into the grid changes nothing (the order is by date).
                .sortable(group: "photos", axis: y)
                .tw("w-full gap-[2px]")
              }
              .tw("w-full")
            }`;
}

/** Album chips under the library header — drop a photo on one to file it. */
const ALBUM_STRIP = `
          Row {
            Row {
              Icon(@resources.heart-fill).size(15).color("#FF375F")
              Text("Favorites").tw("ml-1.5 text-[13px] font-medium whitespace-nowrap").color("${TEXT}")
            }
            .onClick(@router.push, to: "/favorites")
            .dropZone(group: "photos", id: "favorites")
            .onDrop(@actions.dropOnAlbum)
            .states(transition: easeOut, duration: 120) {
              onState(over).backgroundColor("${DROP_OVER}").scale(1.06)
            }
            .tw("items-center shrink-0 rounded-full px-3 h-8 bg-white/10 cursor-pointer")

            ForEach(items: @state.albums, key: "id") {
              Row {
                If(condition: "@{item.hasCover}") {
                  Image(src: "@{item.coverUrl}", alt: "")
                    .objectFit("cover")
                    .tw("w-5 h-5 rounded-[5px]")
                }
                If(condition: "@{!item.hasCover}") {
                  Icon(@resources.albums).size(15).color("${ACCENT}")
                }
                Text("@{item.name}").tw("ml-1.5 text-[13px] font-medium whitespace-nowrap").color("${TEXT}")
              }
              .onClick(@actions.openAlbum, id: "@{item.id}")
              .dropZone(group: "photos", id: "@{item.id}")
              .onDrop(@actions.dropOnAlbum)
              .states(transition: easeOut, duration: 120) {
                onState(over).backgroundColor("${DROP_OVER}").scale(1.06)
              }
              .tw("items-center shrink-0 rounded-full pl-1.5 pr-3 h-8 bg-white/10 cursor-pointer")
            }

            Row {
              Icon(@resources.plus).size(15).color("${MUTED}")
              Text("New album").tw("ml-1 text-[13px] whitespace-nowrap").color("${MUTED}")
            }
            .onClick(@actions.showNewAlbum)
            .tw("items-center shrink-0 rounded-full px-3 h-8 border border-dashed border-white/20 cursor-pointer")
          }
          .tw("w-full gap-2 px-4 pb-2 overflow-x-auto items-center")

          Text("Drag photos onto Favorites or an album to file them.")
            .tw("px-4 pb-1 text-[11px] hidden md:block")
            .color("${MUTED}")`;

const NEW_ALBUM_ROW = `
          If(condition: "@{state.showNewAlbum}") {
            Row {
              Input(placeholder: "Album name")
                .bind(@state.newAlbumName)
                .onKey(@actions.createAlbum)
                .label("New album name")
                .tw("flex-1 min-w-0 rounded-xl px-3 py-2 text-[15px] border border-white/10")
                .backgroundColor("${SURFACE}")
                .color("${TEXT}")
              Button {
                Text("Create").tw("text-[14px] font-semibold").color("#000")
              }
              .onClick(@actions.createAlbum)
              .backgroundColor("${ACCENT}")
              .tw("border-0 rounded-xl px-4 py-2 shrink-0")
              ${iconButton("x", "@actions.hideNewAlbum", "Cancel")}
            }
            .tw("w-full gap-2 px-4 py-2 items-center")
            .enter(fade, slide, from: top, duration: 160)
          }`;

function emptyState(icon: string, title: string, body: string, withButtons: boolean): string {
  return `
            Column {
              Icon(@resources.${icon}).size(54).color("#3A3A3F")
              Text("${title}").tw("mt-4 text-[19px] font-semibold").color("${TEXT}")
              Text("${body}")
                .tw("mt-1.5 text-[13.5px] text-center max-w-[280px] self-center leading-snug")
                .color("${MUTED}")
              ${withButtons ? `
              Row {
                Button {
                  Row {
                    Icon(@resources.camera).size(18).color("#000")
                    Text("Take photo").tw("ml-2 text-[14px] font-semibold").color("#000")
                  }
                  .tw("items-center")
                }
                .onClick(@actions.capture)
                .backgroundColor("${ACCENT}")
                .tw("border-0 rounded-full px-4 py-2.5")
                Button {
                  Row {
                    Icon(@resources.gallery).size(18).color("${TEXT}")
                    Text("Import").tw("ml-2 text-[14px] font-semibold").color("${TEXT}")
                  }
                  .tw("items-center")
                }
                .onClick(@actions.importGallery)
                .tw("bg-white/10 border-0 rounded-full px-4 py-2.5")
              }
              .tw("mt-5 gap-2.5")` : ""}
            }
            .tw("w-full flex-1 items-center justify-center px-8 py-20")`;
}

/** One tab-bar button. */
function tabButton(path: string, icon: string, label: string, active: string): string {
  return `
          Button {
            Column {
              Icon(@resources.${icon})
                .size(22)
                .color("@{${active} ? '${ACCENT}' : '${MUTED}'}")
              Text("${label}")
                .tw("text-[10.5px] mt-0.5 font-medium")
                .color("@{${active} ? '${ACCENT}' : '${MUTED}'}")
            }
            .tw("items-center")
          }
          .onClick(@router.push, to: "${path}")
          .tw("bg-transparent border-0 flex-1 py-1.5 items-center justify-center")`;
}

const TAB_BAR = `
        If(condition: "@{state.location != '/photo'}") {
          Row {
            ${tabButton("/", "photos", "Library", "state.location == '/'")}
            ${tabButton("/favorites", "heart", "Favorites", "state.location == '/favorites'")}

            // The shutter.
            Button {
              Column {}
                .tw("w-[50px] h-[50px] rounded-full")
                .backgroundColor("@{state.busy ? '#8E8E93' : '#FFFFFF'}")
                .transition(160, easeOut)
            }
            .label("Take photo")
            .onClick(@actions.capture)
            .opacity({ default: 1, active: 0.7 })
            .tw("bg-transparent border-[3px] border-white rounded-full w-[62px] h-[62px] p-[3px] items-center justify-center shrink-0 mx-1 -mt-5 shadow-xl")

            ${tabButton("/albums", "albums", "Albums", "state.location == '/albums' || state.location == '/album'")}
            Button {
              Column {
                Icon(@resources.gallery).size(22).color("${MUTED}")
                Text("Import").tw("text-[10.5px] mt-0.5 font-medium").color("${MUTED}")
              }
              .tw("items-center")
            }
            .onClick(@actions.importGallery)
            .tw("bg-transparent border-0 flex-1 py-1.5 items-center justify-center")
          }
          .tw("w-full items-end px-2 pt-1.5 pb-3 border-t border-white/10 shrink-0")
          .backgroundColor("rgba(16, 16, 20, 0.94)")
          .backdropFilter("blur(20px)")
          .enter(fade, slide, from: bottom, duration: 220)
          .exit(fade, duration: 120)
        }`;

const STATUS = `
        If(condition: "@{state.status != ''}") {
          Row {
            If(condition: "@{state.busy}") {
              Spinner().tw("w-4 h-4 mr-2 shrink-0")
            }
            Text("@{state.status}")
              .tw("text-[13px] flex-1 min-w-0")
              .color("${TEXT}")
              .liveRegion("polite")
            Button { Icon(@resources.x).size(14).color("${MUTED}") }
              .label("Dismiss")
              .onClick(@actions.dismissStatus)
              .tw("bg-transparent border-0 p-1 ml-2 shrink-0")
          }
          .tw("mx-3 mb-2 px-3.5 py-2 rounded-2xl items-center border border-white/10 shadow-lg shrink-0")
          .backgroundColor("rgba(40, 40, 46, 0.96)")
          .enter(fade, slide, from: bottom, duration: 180)
          .exit(fade, duration: 120)
        }`;

/** Library / Favorites body: OS file drops land anywhere in it. */
function scrollBody(inner: string): string {
  return `
          Column {
            ${inner}
            Column {}.tw("h-6 shrink-0")
          }
          .tw("w-full flex-1 min-h-0 overflow-y-auto")
          .dropZone(group: "os-files", files: true, accept: "image/*")
          .onFileDragEnter(@actions.importFiles)
          .states { onState(over).backgroundColor("rgba(255, 214, 10, 0.08)") }`;
}

const LIBRARY_ROUTE = `
        Route(path: "/") {
          Column {
            ${header("Library", "@{state.summary}", `
            ${iconButton("upload", "@actions.importFiles", "Add image files")}
            ${iconButton("camera", "@actions.capture", "Take photo", "hidden md:flex")}`)}
            If(condition: "@{!state.libraryEmpty}") {${ALBUM_STRIP}
            }
            ${NEW_ALBUM_ROW}
            ${scrollBody(`
            If(condition: "@{state.libraryEmpty}") {${emptyState(
              "camera",
              "No photos yet",
              "Take a photo, import from your photo library, or drop image files here.",
              true,
            )}
            }
            ${photoGrid("sections", "library")}`)}
          }
          .tw("w-full h-full min-h-0")
        }`;

const FAVORITES_ROUTE = `
        Route(path: "/favorites") {
          Column {
            ${header("Favorites", "@{state.favSummary}")}
            ${scrollBody(`
            If(condition: "@{state.favEmpty}") {${emptyState(
              "heart",
              "No favorites yet",
              "Tap the heart on a photo, or drag a photo onto Favorites in the library.",
              false,
            )}
            }
            ${photoGrid("favSections", "favorites")}`)}
          }
          .tw("w-full h-full min-h-0")
        }`;

const ALBUMS_ROUTE = `
        Route(path: "/albums") {
          Column {
            ${header("Albums", "@{state.usage} used", iconButton("plus", "@actions.showNewAlbum", "New album"))}
            ${NEW_ALBUM_ROW}
            Column {
              If(condition: "@{state.albumsEmpty}") {${emptyState(
                "albums",
                "No albums yet",
                "Create an album, then drag photos onto it in the library.",
                false,
              )}
              }
              Grid(@state.albums, key: "id") {
                Column {
                  Stack {
                    If(condition: "@{item.hasCover}") {
                      Image(src: "@{item.coverUrl}", alt: "Cover of @{item.name}")
                        .objectFit("cover")
                        .tw("w-full h-full")
                    }
                    If(condition: "@{!item.hasCover}") {
                      Column {
                        Icon(@resources.albums).size(34).color("#3A3A3F")
                      }
                      .tw("w-full h-full items-center justify-center")
                    }
                  }
                  .aspectRatio(1)
                  .backgroundColor("${SURFACE}")
                  .tw("w-full rounded-xl overflow-hidden")
                  Text("@{item.name}")
                    .tw("mt-1.5 text-[14px] font-medium w-full truncate text-left")
                    .color("${TEXT}")
                  Text("@{item.countLabel}")
                    .tw("text-[12px] w-full text-left")
                    .color("${MUTED}")
                }
                .onClick(@actions.openAlbum, id: "@{item.id}")
                .dropZone(group: "photos", id: "@{item.id}")
                .onDrop(@actions.dropOnAlbum)
                .states(transition: easeOut, duration: 120) {
                  onState(over).scale(1.04).opacity(0.85)
                }
                .tw("items-start cursor-pointer")
              }
              .gridColumns({ default: 2, sm: 3, md: 4, lg: 5 })
              .columnGap(12)
              .rowGap(18)
              .tw("w-full px-4 pt-2")
            }
            .tw("w-full flex-1 min-h-0 overflow-y-auto pb-6")
          }
          .tw("w-full h-full min-h-0")
        }`;

const ALBUM_ROUTE = `
        Route(path: "/album") {
          Column {
            Row {
              Button {
                Row {
                  Icon(@resources.chevron-left).size(20).color("${ACCENT}")
                  Text("Albums").tw("text-[16px]").color("${ACCENT}")
                }
                .tw("items-center")
              }
              .onClick(@router.push, to: "/albums")
              .tw("bg-transparent border-0 px-2 py-1")
              Column {}.tw("flex-1")
              Button {
                Text("@{state.confirmDeleteAlbum ? 'Delete album?' : 'Delete'}")
                  .tw("text-[14px]")
                  .color("#FF453A")
              }
              .onClick(@actions.deleteAlbum)
              .tw("bg-transparent border-0 px-3 py-1")
            }
            .tw("w-full items-center px-2 pt-3")
            ${header("@{state.album.name}", "@{state.album.countLabel}")}
            Column {
              If(condition: "@{state.albumEmpty}") {${emptyState(
                "albums",
                "This album is empty",
                "Drag photos onto it from the library, or add them from a photo's Album button.",
                false,
              )}
              }
              ${photoGrid("albumSections", "album")}
            }
            .tw("w-full flex-1 min-h-0 overflow-y-auto pb-6")
          }
          .tw("w-full h-full min-h-0")
        }`;

/** One labelled row of the viewer's info panel. */
function infoRow(icon: string, main: string, sub: string, condition = ""): string {
  const row = `
                Row {
                  Icon(@resources.${icon}).size(18).color("${MUTED}").tw("mt-0.5 shrink-0")
                  Column {
                    Text("${main}").tw("text-[14px] w-full text-left").color("${TEXT}")
                    Text("${sub}").tw("text-[12px] mt-0.5 w-full text-left").color("${MUTED}")
                  }
                  .tw("ml-3 flex-1 min-w-0 items-start")
                }
                .tw("w-full items-start py-2")`;
  return condition ? `\n                If(condition: "${condition}") {${row}\n                }` : row;
}

const VIEWER_ROUTE = `
        Route(path: "/photo") {
          Column {
            // ----- Top bar -----
            Row {
              ${iconButton("chevron-left", "@actions.closeViewer", "Back")}
              Column {
                Text("@{state.viewer.title}")
                  .tw("text-[15px] font-semibold w-full truncate text-center")
                  .color("${TEXT}")
                Text("@{state.viewer.subtitle}")
                  .tw("text-[12px] w-full truncate text-center")
                  .color("${MUTED}")
              }
              .tw("flex-1 min-w-0 items-center px-2")
              Text("@{state.viewer.position}")
                .tw("text-[12px] w-10 text-right tabular-nums shrink-0 self-center")
                .color("${MUTED}")
            }
            .tw("w-full items-center px-3 pt-3 pb-2 shrink-0")

            If(condition: "@{state.viewer.id == ''}") {
              Column {
                Text("This photo is gone.").tw("text-[16px]").color("${TEXT}")
                Button { Text("Back to Library").tw("text-[14px] font-semibold").color("#000") }
                  .onClick(@router.push, to: "/")
                  .backgroundColor("${ACCENT}")
                  .tw("mt-4 border-0 rounded-full px-4 py-2")
              }
              .tw("w-full flex-1 items-center justify-center")
            }

            If(condition: "@{state.viewer.id != ''}") {
              // ----- Stage: swipe right = previous (outer), left = next (inner) -----
              Row {
                Button {
                  Icon(@resources.chevron-left).size(22).color("${TEXT}")
                }
                .label("Previous photo")
                .onClick(@actions.prevPhoto)
                .opacity("@{state.viewer.hasPrev ? 1 : 0.15}")
                .tw("bg-white/10 hover:bg-white/20 border-0 rounded-full w-9 h-9 p-0 items-center justify-center shrink-0 ml-1.5")

                Column {
                  If(condition: "@{state.viewer.showable}") {
                    Image(src: "@{state.viewer.url}", alt: "Photo, @{state.viewer.title}")
                      .objectFit("contain")
                      .tw("w-full h-full select-none")
                      .sharedElement("photo-hero", curve: spring, duration: 320)
                      .pointerEvents("none")
                  }
                  If(condition: "@{!state.viewer.showable}") {
                    Column {
                      Icon(@resources.file-image).size(48).color("${MUTED}")
                      Text("HEIC photos can't be shown in a browser.").tw("mt-3 text-[14px]").color("${TEXT}")
                      Text("Download it to open it on your device.").tw("mt-1 text-[12px]").color("${MUTED}")
                    }
                    .tw("w-full h-full items-center justify-center")
                  }
                }
                .tw("flex-1 min-w-0 h-full items-center justify-center")
                .onClick(@actions.toggleInfo)
                .states(@state.swipeNext, transition: easeOut, duration: 200) {
                  onState(center).translateX(0).opacity(1)
                  onState(next).translateX(-260).opacity(0)
                }
                .scrub(from: center, to: next, axis: x, over: [0, -260])
                .settle(curve: easeOut, duration: 200, bind: @state.swipeNext)
                // Engine workaround: it accepts a settle write only for a node
                // that also declares the path with .bind (see README).
                .bind(@state.swipeNext)
                .onAnimationComplete(@actions.swipeSettled)

                Button {
                  Icon(@resources.chevron-right).size(22).color("${TEXT}")
                }
                .label("Next photo")
                .onClick(@actions.nextPhoto)
                .opacity("@{state.viewer.hasNext ? 1 : 0.15}")
                .tw("bg-white/10 hover:bg-white/20 border-0 rounded-full w-9 h-9 p-0 items-center justify-center shrink-0 mr-1.5")
              }
              .tw("w-full flex-1 min-h-0 items-center overflow-hidden")
              .states(@state.swipePrev, transition: easeOut, duration: 200) {
                onState(center).translateX(0).opacity(1)
                onState(prev).translateX(260).opacity(0)
              }
              .scrub(from: center, to: prev, axis: x, over: [0, 260])
              .settle(curve: easeOut, duration: 200, bind: @state.swipePrev)
              .bind(@state.swipePrev)
              .onAnimationComplete(@actions.swipeSettled)

              // ----- Info panel -----
              If(condition: "@{state.showInfo}") {
                Column {${infoRow("calendar", "@{state.viewer.dateLine}", "@{state.viewer.dateNote}")}${infoRow(
                  "aperture",
                  "@{state.viewer.camera}",
                  "@{state.viewer.exposure}",
                  "@{state.viewer.hasCamera || state.viewer.hasExposure}",
                )}${infoRow("file-image", "@{state.viewer.fileLine}", "Albums: @{state.viewer.albumsLine}")}${infoRow(
                  "pin",
                  "@{state.viewer.place}",
                  "@{state.viewer.coords} · © OpenStreetMap contributors",
                  "@{state.viewer.hasGps}",
                )}
                }
                .tw("w-full max-w-[640px] self-center px-4 py-2 shrink-0 max-h-[40vh] overflow-y-auto")
                .enter(fade, slide, from: bottom, duration: 180)
              }

              // ----- Album picker -----
              If(condition: "@{state.showAlbumPicker}") {
                Column {
                  Text("Add to album").tw("text-[13px] font-semibold px-1 pb-1").color("${MUTED}")
                  ForEach(items: @state.pickerAlbums, key: "id") {
                    Button {
                      Row {
                        Icon(@resources.check)
                          .size(18)
                          .color("${ACCENT}")
                          .opacity("@{item.checked ? 1 : 0}")
                        Text("@{item.name}").tw("ml-2 text-[15px] flex-1 text-left truncate").color("${TEXT}")
                      }
                      .tw("items-center w-full")
                    }
                    .onClick(@actions.togglePickerAlbum, id: "@{item.id}")
                    .tw("bg-transparent hover:bg-white/5 border-0 rounded-lg px-2 py-2 w-full")
                  }
                  Row {
                    Input(placeholder: "New album…")
                      .bind(@state.pickerNewName)
                      .onKey(@actions.createAlbumFromPicker)
                      .label("New album name")
                      .tw("flex-1 min-w-0 rounded-lg px-3 py-2 text-[14px] border border-white/10")
                      .backgroundColor("#000")
                      .color("${TEXT}")
                    Button { Text("Add").tw("text-[14px] font-semibold").color("#000") }
                      .onClick(@actions.createAlbumFromPicker)
                      .backgroundColor("${ACCENT}")
                      .tw("border-0 rounded-lg px-3 py-2 ml-2 shrink-0")
                  }
                  .tw("w-full items-center pt-2")
                }
                .tw("w-full max-w-[640px] self-center mx-3 mb-2 p-3 rounded-2xl border border-white/10 shrink-0 max-h-[45vh] overflow-y-auto")
                .backgroundColor("${SURFACE}")
                .enter(fade, slide, from: bottom, duration: 180)
              }

              // ----- Delete confirmation -----
              If(condition: "@{state.confirmDelete}") {
                Row {
                  Text("Delete this photo? This can't be undone.").tw("text-[14px] flex-1 min-w-0").color("${TEXT}")
                  Button { Text("Cancel").tw("text-[14px]").color("${TEXT}") }
                    .onClick(@actions.cancelDelete)
                    .tw("bg-white/10 border-0 rounded-lg px-3 py-1.5 ml-2 shrink-0")
                  Button { Text("Delete").tw("text-[14px] font-semibold").color("#FFFFFF") }
                    .onClick(@actions.deletePhoto)
                    .backgroundColor("#FF453A")
                    .tw("border-0 rounded-lg px-3 py-1.5 ml-2 shrink-0")
                }
                .tw("w-full max-w-[640px] self-center mx-3 mb-2 px-3 py-2.5 rounded-2xl items-center shrink-0")
                .backgroundColor("${SURFACE}")
                .enter(fade, duration: 140)
              }

              // ----- Toolbar -----
              Row {
                ${iconButton("download", "@actions.download", "Download")}
                Button {
                  Icon(@resources.heart-fill).size(22).color("@{state.viewer.fav ? '#FF375F' : 'rgba(255,255,255,0.18)'}")
                }
                .label("Favorite")
                .onClick(@actions.toggleFavorite)
                .opacity({ default: 1, active: 0.6 })
                .tw("bg-white/10 hover:bg-white/15 border-0 rounded-full w-10 h-10 p-0 items-center justify-center shrink-0")
                ${iconButton("albums", "@actions.toggleAlbumPicker", "Add to album")}
                ${iconButton("info", "@actions.toggleInfo", "Info")}
                ${iconButton("trash", "@actions.askDelete", "Delete", "", "#FF453A")}
              }
              .tw("w-full max-w-[420px] self-center items-center justify-between px-6 pt-2 pb-4 shrink-0")
            }
          }
          .tw("w-full h-full min-h-0")
          .backgroundColor("#000000")
        }`;

export const TEMPLATE = `
  module App {
    Column {
      Column {
        Router {${LIBRARY_ROUTE}${FAVORITES_ROUTE}${ALBUMS_ROUTE}${ALBUM_ROUTE}${VIEWER_ROUTE}
        }
      }
      .tw("w-full flex-1 min-h-0 overflow-hidden")
      ${STATUS}
      ${TAB_BAR}
    }
    .tw("w-full h-screen min-h-0 overflow-hidden")
    .backgroundColor("${BG}")
    .color("${TEXT}")
  }
`;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default app
  .defineState<PhotosState>(initialState())
  .onCreated((state) => {
    // The visitor's library lives in this Durable Object (see library.ts).
    refreshLibrary(state);
    void geocodePending(state, currentLibrary());
  })
  .onDestroyed((state) => stopSwipes(state))
  .onAction("capture", ({ state, context }) => capture(state, context))
  .onAction("importGallery", ({ state, context }) => importGallery(state, context))
  .onAction("importFiles", ({ state, context }) => importFiles(state, context))
  .onAction("download", ({ state, context }) => download(state, context))
  .onAction("dismissStatus", ({ state }) => {
    state.status = "";
  })
  .onAction<{ id: string; from?: string }>("openPhoto", ({ state, context, action }) =>
    openPhoto(state, context, action.payload?.id, action.payload?.from),
  )
  .onAction("closeViewer", ({ state, context }) => closeViewer(state, context))
  .onAction("nextPhoto", ({ state }) => step(state, 1))
  .onAction("prevPhoto", ({ state }) => step(state, -1))
  .onAction<{ animation?: string; state?: string }>("swipeSettled", ({ state, action }) => {
    // A swipe settled on the "next"/"prev" pose: page, then the pose returns
    // to center with the new photo. Other completions (center) are ignored.
    if (action.payload?.animation !== "states") return;
    if (action.payload.state === "next" && state.swipeNext === "next") step(state, 1);
    else if (action.payload.state === "prev" && state.swipePrev === "prev") step(state, -1);
  })
  .onAction<{ id?: string }>("toggleFavorite", ({ state, action }) => toggleFavorite(state, action.payload?.id))
  .onAction("toggleInfo", ({ state }) => {
    state.showInfo = !state.showInfo;
    if (state.showInfo) state.showAlbumPicker = false;
  })
  .onAction("toggleAlbumPicker", ({ state }) => {
    state.showAlbumPicker = !state.showAlbumPicker;
    state.pickerNewName = "";
    if (state.showAlbumPicker) {
      state.showInfo = false;
      loadPicker(state);
    }
  })
  .onAction<{ id: string }>("togglePickerAlbum", ({ state, action }) => togglePickerAlbum(state, action.payload?.id))
  .onAction("createAlbumFromPicker", ({ state }) => {
    if (!state.viewer.id || !state.pickerNewName.trim()) return;
    const name = state.pickerNewName;
    state.pickerNewName = "";
    if (createAlbum(state, name, state.viewer.id)) {
      loadPicker(state);
      loadViewer(state, state.viewer.id);
    }
  })
  .onAction("askDelete", ({ state }) => {
    state.confirmDelete = true;
    state.showAlbumPicker = false;
  })
  .onAction("cancelDelete", ({ state }) => {
    state.confirmDelete = false;
  })
  .onAction("deletePhoto", ({ state, context }) => deletePhoto(state, context))
  .onAction<DndEventPayload>("dropOnAlbum", ({ state, action }) => dropOnAlbum(state, action.payload))
  .onAction("showNewAlbum", ({ state }) => {
    state.showNewAlbum = true;
    state.newAlbumName = "";
  })
  .onAction("hideNewAlbum", ({ state }) => {
    state.showNewAlbum = false;
  })
  .onAction("createAlbum", ({ state }) => {
    const name = state.newAlbumName;
    if (!name.trim()) return;
    const existed = currentLibrary().albumNamed(name) !== null;
    if (createAlbum(state, name)) {
      state.showNewAlbum = false;
      state.newAlbumName = "";
      state.status = existed
        ? `You already have an album called “${name.trim()}”.`
        : `Created album “${name.trim()}”. Drag photos onto it.`;
    }
  })
  .onAction<{ id: string }>("openAlbum", ({ state, context, action }) => openAlbum(state, context, action.payload?.id))
  .onAction("deleteAlbum", ({ state, context }) => {
    if (!state.album.id) return;
    if (!state.confirmDeleteAlbum) {
      state.confirmDeleteAlbum = true;
      return;
    }
    const name = state.album.name;
    currentLibrary().deleteAlbum(state.album.id);
    state.album = { id: "", name: "", countLabel: "" };
    state.confirmDeleteAlbum = false;
    state.status = `Deleted album “${name}”. Its photos stay in the library.`;
    refreshLibrary(state);
    navigate(state, context, "/albums");
  })
  .ui(TEMPLATE);
