// HTML → safe text for the renderer.
//
// Hacker News comment/story text and the Wikipedia feed's `story` blurbs are
// HTML. Hypen has no raw-HTML component (by design: patches carry props, not
// markup), so everything that reaches the UI goes through here first:
//
//   - tags are dropped, never passed through — no markup can reach a client;
//   - <p>, <br> and block tags become paragraph breaks, <pre> keeps its
//     line structure (rendered with `whiteSpace: pre-wrap`);
//   - <a href> keeps its visible text inline and is ALSO collected into a
//     `links` list (http/https only), which the UI renders as tappable
//     `Link(target: "_blank")` chips. `javascript:` / `data:` and relative
//     hrefs are discarded;
//   - entities are decoded once, after tags are gone, so `&lt;script&gt;`
//     decodes to literal text and is never re-parsed as a tag.

export interface TextLink {
  /** Stable per-comment key for the ForEach. */
  id: string;
  href: string;
  /** Short label: host + trimmed path. */
  label: string;
}

export interface RichText {
  text: string;
  links: TextLink[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  middot: "·",
  bull: "•",
  euro: "€",
  pound: "£",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      // Drop C0 controls other than tab/newline.
      if (code < 32 && code !== 9 && code !== 10) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Only absolute http(s) URLs survive. */
export function safeHref(raw: string): string | null {
  const href = decodeEntities(raw.trim());
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function linkLabel(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    let path = decodeURIComponent(url.pathname + url.search).replace(/\/$/, "");
    if (path.length > 28) path = `${path.slice(0, 27)}…`;
    return host + path;
  } catch {
    return href.slice(0, 40);
  }
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Convert an HN/Wikipedia HTML fragment to plain text plus its links.
 * `maxLinks` caps the chip list (a link-dump comment stays readable).
 */
export function htmlToRichText(html: string | undefined | null, maxLinks = 6): RichText {
  if (!html) return { text: "", links: [] };
  const links: TextLink[] = [];
  const seen = new Set<string>();
  let inPre = 0;
  let out = "";
  // Finished blocks; <pre> blocks keep their whitespace verbatim.
  const blocks: { pre: boolean; text: string }[] = [];
  const flush = (pre: boolean) => {
    if (out) blocks.push({ pre, text: out });
    out = "";
  };

  // Tokenise into tags and text runs. Comments are removed first.
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (m[2] !== undefined || m[3] !== undefined) {
      const run = m[2] ?? m[3] ?? "";
      out += inPre ? run : run.replace(/\s+/g, " ");
      continue;
    }
    const whole = m[0];
    const name = (m[1] ?? "").toLowerCase();
    const closing = whole.startsWith("</");
    switch (name) {
      case "p":
      case "div":
      case "li":
      case "blockquote":
        out += "\n\n";
        break;
      case "br":
        out += "\n";
        break;
      case "pre":
        if (closing) {
          if (inPre === 1) flush(true);
          inPre = Math.max(0, inPre - 1);
        } else {
          if (inPre === 0) flush(false);
          inPre += 1;
        }
        break;
      case "a": {
        if (closing) break;
        const href = attr(whole, "href");
        const safe = href ? safeHref(href) : null;
        if (safe && !seen.has(safe) && links.length < maxLinks) {
          seen.add(safe);
          links.push({ id: `l${links.length}`, href: safe, label: linkLabel(safe) });
        }
        break;
      }
      case "script":
      case "style": {
        // Skip the element's content entirely.
        if (closing) break;
        const end = source.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        re.lastIndex = end === -1 ? source.length : end;
        break;
      }
      default:
        // Inline formatting (<i>, <b>, <code>, <span>…) contributes nothing.
        break;
    }
  }

  flush(inPre > 0);
  const paras: string[] = [];
  for (const block of blocks) {
    const decoded = decodeEntities(block.text);
    if (block.pre) {
      const code = decoded.replace(/^\n+|\s+$/g, "");
      if (code) paras.push(code);
      continue;
    }
    for (const para of decoded.split(/\n{2,}/)) {
      const clean = para
        .split("\n")
        .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
        .join("\n")
        .trim();
      if (clean) paras.push(clean);
    }
  }
  const text = paras.join("\n\n");
  return { text, links };
}

/** Plain text only (Wikipedia blurbs, titles with <i>). */
export function htmlToText(html: string | undefined | null): string {
  return htmlToRichText(html, 0).text.replace(/\s*\n\s*/g, " ").trim();
}
