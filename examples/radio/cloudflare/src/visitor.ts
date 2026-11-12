// Visitor identity and connection country.
//
// - Visitor: a random `hypen_radio` cookie routes every socket from the same
//   browser to the same Durable Object, so favourites and recently played
//   (persisted in that DO's storage) follow the visitor across reloads.
//   The cookie is minted on the page response AND on the WebSocket upgrade
//   response, because inside the launcher the browser never loads this
//   worker's page — it only opens `ws://…/ws`.
// - Country: Cloudflare puts the caller's country on `request.cf.country`.
//   That only exists on the edge request, so the worker stamps it into a
//   header for the DO hop, the DO stores it, and every DO entry point runs
//   inside `countryScope` so module handlers can read it with
//   `currentCountry()` — scoped to this DO, not shared through a module-level
//   slot with other visitors' DOs in the same isolate.

// @ts-ignore - provided by the nodejs_compat flag; workers-types lacks node typings.
import { AsyncLocalStorage } from "node:async_hooks";

export const VISITOR_COOKIE = "hypen_radio";
export const COUNTRY_HEADER = "x-radio-country";
const VISITOR_ID = /^[0-9a-f-]{36}$/;

/** Used when the edge gives no country (e.g. `wrangler dev` offline). */
export const FALLBACK_COUNTRY = "US";

export function visitorFrom(request: Request): string | null {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)hypen_radio=([^;]+)/);
  const id = match?.[1];
  return id && VISITOR_ID.test(id) ? id : null;
}

export function visitorCookie(id: string, secure: boolean): string {
  // SameSite=Lax: same-site embeds (the launcher on another localhost port)
  // still send it; cross-site pages cannot open a socket into this DO.
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function edgeCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const code = typeof cf?.country === "string" ? cf.country.toUpperCase() : "";
  // "XX" / "T1" (Tor) are not real countries.
  return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
}

export const countryScope: {
  run<R>(store: string, fn: () => R): R;
  getStore(): string | undefined;
} = new AsyncLocalStorage();

export function currentCountry(): string {
  return countryScope.getStore() ?? FALLBACK_COUNTRY;
}
