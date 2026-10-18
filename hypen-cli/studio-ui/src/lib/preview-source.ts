/**
 * Decides where the editor Preview gets its UI from.
 *
 *   - `remote` / external: the project's own server (server-based projects,
 *     `hypen run --studio`) — `HYPEN_REMOTE_URL`.
 *   - `remote` / studio engine: the studio-hosted RemoteServer at
 *     `/ws/engine`. This is the default for file-based projects: the real
 *     module definitions run there (entry + nested modules + router), so
 *     taps, `@router.push` and lifecycle hooks behave exactly like
 *     `hypen dev` / Test Mode. Edits reach it through Studio's autosave and
 *     the components-dir watcher (`engineHost.reload()`).
 *   - `local`: in-browser fallback when the studio engine can't serve (no
 *     entry component yet, bootstrap failed). Renders the open `.hypen`
 *     buffer with only the entry's own module wired — layout-first.
 */

export type PreviewSource =
  | { kind: "remote"; url: string; external: boolean }
  | { kind: "local"; reason?: string };

/** Shape of `GET /api/engine/status`. */
export interface EngineStatus {
  ready?: boolean;
  state?: "starting" | "ready" | "unavailable";
  reason?: string;
  remoteUrl?: string;
}

/** ws(s):// URL of the studio-hosted engine for a page at `loc`. */
export function studioEngineWsUrl(loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws/engine`;
}

/**
 * Pick the preview source from an engine status poll. Returns `null` while
 * the engine is still starting (poll again) unless `timedOut`, in which case
 * the in-browser fallback is used so the preview never hangs blank.
 */
export function pickPreviewSource(
  status: EngineStatus | null,
  loc: { protocol: string; host: string },
  timedOut = false
): PreviewSource | null {
  if (status?.remoteUrl) {
    return { kind: "remote", url: status.remoteUrl, external: true };
  }
  const state = status?.state ?? (status?.ready ? "ready" : undefined);
  if (state === "ready") {
    return { kind: "remote", url: studioEngineWsUrl(loc), external: false };
  }
  if (state === "unavailable") {
    return { kind: "local", reason: status?.reason };
  }
  if (timedOut) {
    return { kind: "local", reason: status ? "engine start timed out" : "engine status unreachable" };
  }
  return null;
}
