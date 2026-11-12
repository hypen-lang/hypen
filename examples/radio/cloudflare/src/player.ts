// The player lives in the App shell (primary module), so it survives every
// route change: the one `Video` node that actually plays is mounted in the
// App template, outside the Router. Screens are nested modules; their play /
// favourite buttons reach the shell through `context.getModule("app")` and
// call the helpers below on its live state proxy.

import type { GlobalContext } from "@hypen-space/core";
import { countClick, type Station } from "./radio-browser";
import { fetchIcyTitle } from "./icy";

export interface PlayerState {
  /** Mirror of the router path (kept by the runtime). */
  location: string;
  /** The station in the player (also persisted, so the bar can offer "resume"). */
  now: Station;
  hasStation: boolean;
  /** true while the Video node is mounted (connected or connecting). */
  live: boolean;
  streamUrl: string;
  /**
   * "idle" | "connecting" | "playing" | "paused" — driven by the Video's
   * onPlay / onPause / onError events (see App.ts for why not `.bind`).
   */
  phase: string;
  muted: boolean;
  hasError: boolean;
  error: string;
  /** ICY StreamTitle read server-side; empty when the stream has none. */
  nowTitle: string;
  hasNowTitle: boolean;
  isFavourite: boolean;
  favourites: Station[];
  recents: Station[];
  hasFavourites: boolean;
  hasRecents: boolean;
  /** Per-instance id for the ICY poll timer registry (never rendered). */
  token: string;
}

export const EMPTY_STATION: Station = {
  id: "",
  name: "",
  stream: "",
  art: "",
  homepage: "",
  hasHomepage: false,
  tags: "",
  country: "",
  countrycode: "",
  flag: "",
  language: "",
  codec: "",
  bitrate: 0,
  quality: "",
  subtitle: "",
  votes: 0,
  clicks: 0,
  playable: false,
  unplayableReason: "",
};

const MAX_RECENTS = 20;
const ICY_POLL_MS = 30_000;

/** Plain copy: station objects often arrive as another module's state proxy. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function shell(context: GlobalContext | undefined): PlayerState | null {
  if (!context?.hasModule("app")) return null;
  return context.getModule<PlayerState>("app").state;
}

/**
 * Open the full player. `/player` is an inline route in the App template (no
 * module behind it), and a screen module's `router.push("/player")` is a
 * no-op in this SDK build — so write the shell's router mirror instead.
 */
export function openPlayer(context: GlobalContext | undefined): void {
  if (!context?.hasModule("app")) return;
  const ref = context.getModule<PlayerState & { returnTo: string }>("app");
  const from = ref.getState().location;
  ref.setState({ returnTo: from === "/player" ? "/" : from, location: "/player" });
}

export function isFavourite(player: PlayerState, id: string): boolean {
  return player.favourites.some((s) => s.id === id);
}

export function startStation(player: PlayerState, station: Station): void {
  if (!station.playable || !station.stream) return;
  const copy = plain(station);
  player.now = copy;
  player.hasStation = true;
  player.streamUrl = copy.stream;
  // The Video's onPlay flips this to "playing" once audio actually flows.
  player.phase = "connecting";
  player.live = true;
  player.hasError = false;
  player.error = "";
  player.nowTitle = "";
  player.hasNowTitle = false;
  player.isFavourite = isFavourite(player, copy.id);
  player.recents = [copy, ...player.recents.filter((s) => s.id !== copy.id)].slice(0, MAX_RECENTS);
  player.hasRecents = true;
  // Radio Browser etiquette: one click per listener-initiated start.
  void countClick(copy.id).then((ok) => {
    if (!ok) console.warn(`[radio] Radio Browser did not count the click for ${copy.id}`);
  });
  startIcy(player);
}

/**
 * Stop = unmount the Video. For live radio that's the right "pause": the
 * connection is released, and the next play reconnects at the live edge
 * instead of resuming minutes-old buffered audio.
 */
export function stopStation(player: PlayerState): void {
  player.live = false;
  player.phase = "idle";
  player.nowTitle = "";
  player.hasNowTitle = false;
  stopIcy(player);
}

export function togglePlayback(player: PlayerState): void {
  if (player.live) stopStation(player);
  else if (player.hasStation) startStation(player, player.now);
}

export function toggleFavourite(player: PlayerState, station: Station): boolean {
  const copy = plain(station);
  if (isFavourite(player, copy.id)) {
    player.favourites = player.favourites.filter((s) => s.id !== copy.id);
  } else {
    player.favourites = [copy, ...player.favourites];
  }
  player.hasFavourites = player.favourites.length > 0;
  player.isFavourite = isFavourite(player, player.now.id);
  return isFavourite(player, copy.id);
}

// ---------------------------------------------------------------------------
// ICY now-playing polling (server-side; see icy.ts)
// ---------------------------------------------------------------------------

const icyTimers = new Map<string, ReturnType<typeof setInterval>>();
/** Bumped on every start/stop so a poll that resolves late can't revive a timer. */
const icyGeneration = new Map<string, number>();

async function pollIcy(player: PlayerState, url: string): Promise<boolean> {
  const result = await fetchIcyTitle(url);
  // The listener may have switched station or stopped while we waited.
  if (!player.live || player.streamUrl !== url) return false;
  if (result.kind === "title") {
    player.nowTitle = result.title;
    player.hasNowTitle = true;
    return true;
  }
  player.nowTitle = "";
  player.hasNowTitle = false;
  // "unsupported" = the stream carries no ICY metadata: stop asking.
  return result.kind === "none";
}

export function startIcy(player: PlayerState): void {
  stopIcy(player);
  const url = player.streamUrl;
  const token = player.token;
  const generation = icyGeneration.get(token) ?? 0;
  void pollIcy(player, url).then((keepPolling) => {
    if (icyGeneration.get(token) !== generation) return;
    if (!keepPolling || !player.live || player.streamUrl !== url) return;
    icyTimers.set(
      token,
      setInterval(() => {
        void pollIcy(player, url).then((again) => {
          if (!again) stopIcyToken(token);
        });
      }, ICY_POLL_MS),
    );
  });
}

function stopIcyToken(token: string): void {
  icyGeneration.set(token, (icyGeneration.get(token) ?? 0) + 1);
  const timer = icyTimers.get(token);
  if (timer) clearInterval(timer);
  icyTimers.delete(token);
}

export function stopIcy(player: PlayerState): void {
  stopIcyToken(player.token);
}

/** Module teardown: drop every trace of this instance's poller. */
export function disposeIcy(player: PlayerState): void {
  stopIcyToken(player.token);
  icyGeneration.delete(player.token);
}

/** Look a station up by id across every Station[] in a screen's state. */
export function findStation(state: object, id: string | undefined): Station | null {
  if (!id) return null;
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) {
      const hit = value.find((v) => v && typeof v === "object" && (v as Station).id === id);
      if (hit) return hit as Station;
    } else if (value && typeof value === "object" && (value as Station).id === id) {
      return value as Station;
    }
  }
  return null;
}
