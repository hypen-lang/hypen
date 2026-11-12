// Action handlers every screen module shares (the `stationRows` fragment and
// `subHeader` in ui.ts dispatch them).

import type { GlobalContext } from "@hypen-space/core";
import { findStation, shell, startStation } from "./player";

type Ctx = { action: { payload?: unknown }; state: object; context: GlobalContext };

function payloadId(action: Ctx["action"]): string | undefined {
  const id = (action.payload as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

export function play({ action, state, context }: Ctx): void {
  const station = findStation(state, payloadId(action));
  const player = shell(context);
  if (station && player) startStation(player, station);
}

export function openStation({ action, context }: Ctx): void {
  const id = payloadId(action);
  if (id) context?.router?.push(`/station/${id}`);
}

export function back({ context }: Ctx): void {
  const router = context?.router;
  if (!router) return;
  const before = router.getCurrentPath();
  router.back();
  // Deep link with no history: fall back to Discover.
  if (router.getCurrentPath() === before) router.push("/");
}

/** Read a `:param` from the current route (URL-decoded). */
export function routeParam(context: GlobalContext | undefined, pattern: string, name: string): string {
  const path = context?.router?.getCurrentPath() ?? "/";
  const raw = context?.router?.matchPath(pattern, path)?.params[name] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
