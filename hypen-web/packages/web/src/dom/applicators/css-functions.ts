/**
 * Composable CSS function lists (`transform`, `filter`).
 *
 * Several applicators share ONE CSS property made of functions —
 * `translateX(...) scale(...)`, `blur(...) saturate(...)`. Each applicator
 * must REPLACE its own function in that list and leave the others alone.
 * Appending instead accumulates on every re-application, so a reactive
 * `.scale("@{hovered ? 1.07 : 1}")` became `scale(1) scale(1.07) scale(1)`
 * (product 1.07 — the hovered icon never scaled back down), and every
 * animation frame written through the same applicator grew the string.
 */

/**
 * Split a function list into `[fn, arg]` pairs. Hand-rolled rather than a
 * regex because arguments nest parens — `translateX(calc(100% - 10px))`,
 * `drop-shadow(0 0 2px rgb(0 0 0 / 50%))` — and a `[^)]*` match would cut
 * the first of those at the inner `)`, leaving the declaration invalid.
 */
export function parseCssFunctionList(value: string): Array<[fn: string, arg: string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < value.length) {
    const open = value.indexOf("(", i);
    if (open === -1) break;
    const fn = value.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < value.length && depth > 0) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")") depth--;
      j++;
    }
    if (fn) out.push([fn, value.slice(open + 1, depth === 0 ? j - 1 : j)]);
    i = j;
  }
  return out;
}

/**
 * Set `fn(arg)` inside the function list held by `el.style[property]`,
 * replacing an existing `fn(...)` in place (keeping list order) or
 * appending when absent. Duplicates of `fn` left by older accumulation
 * collapse into the one replaced entry.
 *
 * A `null`/`undefined` arg REMOVES the function: `RemoveProp` re-runs the
 * applicator with `undefined`, and writing `scale(undefined)` would make
 * the browser reject the entire declaration — every sibling transform
 * would vanish along with the removed one.
 */
export function setCssFunction(
  el: HTMLElement,
  property: "transform" | "filter" | "backdropFilter",
  fn: string,
  arg: string | null | undefined,
): void {
  const current = el.style[property] || "";
  const parts: string[] = [];
  let replaced = false;
  for (const [name, existingArg] of parseCssFunctionList(current)) {
    if (name === fn) {
      if (!replaced && arg != null) {
        parts.push(`${fn}(${arg})`);
      }
      replaced = true;
      continue;
    }
    parts.push(`${name}(${existingArg})`);
  }
  if (!replaced && arg != null) parts.push(`${fn}(${arg})`);
  el.style[property] = parts.join(" ");
}

/** `null`/`undefined` pass through (= remove); anything else is stringified. */
export function fnArg(value: unknown, format: (v: unknown) => string = String): string | null {
  return value == null ? null : format(value);
}
