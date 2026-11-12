// ICY ("SHOUTcast/Icecast") in-band now-playing metadata.
//
// Browsers can't read it: a media element never exposes the interleaved
// metadata blocks, and fetch() from the page would need CORS on the stream
// host. So the worker asks the station itself — one short request with
// `Icy-MetaData: 1`, reads up to the first metadata block (the server says
// where via the `icy-metaint` header, typically 8–32 KB in), parses
// `StreamTitle='…';` and hangs up. Those bytes are discarded: the server never
// relays audio to the client.
//
// If the station doesn't advertise `icy-metaint`, or the first block carries
// no title, we report nothing and the UI shows nothing. No guessing.

import { USER_AGENT } from "./radio-browser";

/** Largest metaint we'll read through to reach the first block. */
const MAX_METAINT = 64 * 1024;

export type IcyResult =
  | { kind: "title"; title: string }
  | { kind: "none" } // stream advertises ICY but the block has no title
  | { kind: "unsupported" }; // no icy-metaint (or not an ICY server)

/** Parse `StreamTitle='Artist - Song';StreamUrl='';` → "Artist - Song". */
export function parseStreamTitle(block: string): string {
  const match = /StreamTitle='(.*?)';/s.exec(block);
  const title = (match?.[1] ?? "").replace(/\0+$/, "").trim();
  // Some stations send only a dash or their own name padding; keep it honest
  // by dropping obviously empty placeholders.
  if (!title || /^[-\s]+$/.test(title)) return "";
  // Some playout systems send internal track ids ("4727 - 4727"): no letters
  // means nothing a listener could read, so show nothing.
  if (!/\p{L}/u.test(title)) return "";
  return title;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    // Older SHOUTcast servers send Latin-1.
    return new TextDecoder("latin1").decode(bytes);
  }
}

/**
 * Pull exactly `metaint` audio bytes (discarded) + 1 length byte + the
 * metadata block out of a byte stream.
 */
export async function readFirstBlock(
  body: ReadableStream<Uint8Array>,
  metaint: number,
): Promise<string> {
  const reader = body.getReader();
  let skipped = 0;
  let length = -1;
  const meta: number[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      let i = 0;
      if (skipped < metaint) {
        const take = Math.min(metaint - skipped, value.length);
        skipped += take;
        i = take;
      }
      if (skipped < metaint) continue;
      if (length < 0 && i < value.length) {
        length = value[i] * 16;
        i += 1;
        if (length === 0) return "";
      }
      if (length < 0) continue;
      for (; i < value.length && meta.length < length; i++) meta.push(value[i]);
      if (meta.length >= length) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return decode(new Uint8Array(meta));
}

export async function fetchIcyTitle(streamUrl: string, timeoutMs = 8000): Promise<IcyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Follow redirects by hand (stream dispatchers commonly 302 to an edge
    // node) so the Icy-MetaData header is sent on every hop.
    let url = streamUrl;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        headers: { "Icy-MetaData": "1", "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "manual",
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      res.body?.cancel().catch(() => {});
      url = new URL(location, url).toString();
      if (!url.startsWith("https://")) return { kind: "unsupported" };
    }
    if (!res) return { kind: "unsupported" };
    const metaint = Number(res.headers.get("icy-metaint"));
    if (!res.ok || !res.body || !Number.isFinite(metaint) || metaint <= 0 || metaint > MAX_METAINT) {
      res.body?.cancel().catch(() => {});
      return { kind: "unsupported" };
    }
    const title = parseStreamTitle(await readFirstBlock(res.body, metaint));
    return title ? { kind: "title", title } : { kind: "none" };
  } catch {
    return { kind: "unsupported" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
