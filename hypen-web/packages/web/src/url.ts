/**
 * URL safety shared by every renderer that turns a prop into a navigation
 * target (the DOM `<a href>` and the canvas bare-Link activation).
 */

/** Schemes a Link may navigate to. Anything else with a scheme is refused. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Return `value` as a safe `href`, or `null` when it must not become one.
 *
 * Link targets often come from state (user profiles, CMS content, remote
 * sessions), so `javascript:` / `vbscript:` / `data:` / `blob:` / `file:`
 * and any other non-web scheme are refused — a `javascript:` href runs script
 * in the app's origin on click. Allowed: `http(s):`, `mailto:`, `tel:`, and
 * scheme-less references (relative paths, `/abs`, `//host`, `?q`, `#frag`).
 *
 * The scheme is read the way the URL parser reads it: leading C0 controls and
 * spaces are stripped and tab/newline are ignored anywhere, so obfuscations
 * like `" java\tscript:…"` or `"JaVaScRiPt:…"` are caught.
 */
export function sanitizeHref(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  // eslint-disable-next-line no-control-regex
  const normalized = raw.replace(/^[\u0000- ]+/, "").replace(/[\t\n\r]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  if (!scheme) {
    // No scheme: relative reference. A colon before any `/`, `?` or `#`
    // that did not form a valid scheme (e.g. `1javascript:`) is still
    // resolved as a path by the URL parser, so it is safe.
    return raw;
  }
  return ALLOWED_SCHEMES.has(scheme[1].toLowerCase()) ? raw : null;
}
