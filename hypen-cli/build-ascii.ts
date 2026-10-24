/**
 * ASCII-escaping helpers for the CLI build (see build.ts).
 *
 * Bun reads files that start with its `// @bun` pragma as Latin-1, so any
 * raw UTF-8 in the published bundle turns into mojibake ("→" prints as
 * "â\u0086\u0092"). Escaping every non-ASCII code unit as `\uXXXX` makes the
 * output decode identically under any charset.
 *
 * `\uXXXX` has the same meaning in every place non-ASCII text appears in our
 * bundles: string literals, template literals (cooked), regex literals, and
 * comments (where it is inert text). It would change a `String.raw`/tagged
 * template's `.raw` view, so `escapeNonAscii` refuses input that uses
 * `String.raw` on a line with non-ASCII text rather than silently altering it.
 */

/** Replace every non-ASCII UTF-16 code unit with a `\uXXXX` escape. */
export function escapeNonAscii(source: string): string {
  if (!/[^\x00-\x7f]/.test(source)) return source;
  for (const line of source.split("\n")) {
    if (/String\.raw/.test(line) && /[^\x00-\x7f]/.test(line)) {
      throw new Error(
        `escapeNonAscii: refusing to escape non-ASCII inside String.raw: ${line.trim().slice(0, 120)}`
      );
    }
  }
  return source.replace(/(\\*)([^\x00-\x7f])/g, (_, slashes: string, ch: string) => {
    // `\→` is an identity escape (it means "→"); escaping the character
    // after an unpaired backslash would yield `\\u2192` (a literal
    // backslash), so drop the now-redundant backslash instead.
    const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes;
    return kept + "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

/** Offset of the first byte >= 0x80, or -1 when the buffer is pure ASCII. */
export function findNonAscii(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! > 0x7f) return i;
  }
  return -1;
}
