// Unit tests for the Radio Browser client, ICY reader and artwork fallback.
// Network-free: `stations-search.json` is a recorded /json/stations/search
// response (trimmed to the fields we read), and fetch is stubbed.

import { afterEach, describe, expect, test } from "bun:test";
import fixture from "./fixtures/stations-search.json";
import {
  flagEmoji,
  normalize,
  playability,
  playableStations,
  searchStations,
  type RawStation,
} from "../src/radio-browser";
import { parseStreamTitle, readFirstBlock } from "../src/icy";
import { monogram } from "../src/art";

const raws = fixture as RawStation[];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("playability", () => {
  test("accepts https progressive MP3/AAC only", () => {
    for (const raw of raws) {
      const ok = playability(raw) === "";
      const expected =
        raw.url_resolved.startsWith("https://") && raw.hls === 0 && ["MP3", "AAC", "AAC+"].includes(raw.codec.toUpperCase());
      expect(ok).toBe(expected);
    }
  });

  test("explains why a station is filtered", () => {
    expect(playability({ url_resolved: "http://x/stream", hls: 0, codec: "MP3" })).toContain("HTTP");
    expect(playability({ url_resolved: "https://x/a.m3u8", hls: 1, codec: "AAC" })).toContain("HLS");
    expect(playability({ url_resolved: "https://x/s.ogg", hls: 0, codec: "OGG" })).toContain("OGG");
  });

  test("the recorded sample contains both playable and filtered stations", () => {
    expect(raws.some((r) => playability(r) === "")).toBe(true);
    expect(raws.some((r) => playability(r) !== "")).toBe(true);
  });
});

describe("normalize / playableStations", () => {
  test("drops unplayable stations and duplicate names, respects the limit", () => {
    const dup = { ...raws.find((r) => playability(r) === "")!, stationuuid: "00000000-0000-0000-0000-000000000000" };
    const list = playableStations([...raws, dup], 50);
    expect(list.every((s) => s.playable && s.stream.startsWith("https://"))).toBe(true);
    expect(new Set(list.map((s) => s.name.toLowerCase())).size).toBe(list.length);
    expect(playableStations(raws, 2).length).toBeLessThanOrEqual(2);
  });

  test("builds UI fields; unplayable stations carry no stream URL", () => {
    const unplayable = raws.find((r) => playability(r) !== "")!;
    const s = normalize(unplayable);
    expect(s.stream).toBe("");
    expect(s.playable).toBe(false);
    expect(s.unplayableReason).not.toBe("");
    const ok = normalize(raws.find((r) => playability(r) === "")!);
    expect(ok.art).toBe(`/art/${ok.id}`);
    expect(ok.quality).toMatch(/MP3|AAC/);
  });

  test("flag emoji from ISO code", () => {
    expect(flagEmoji("de")).toBe("🇩🇪");
    expect(flagEmoji("")).toBe("");
  });
});

describe("searchStations", () => {
  test("asks Radio Browser for https, non-broken stations and filters the rest locally", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^HypenRadioExample/);
      if (url.endsWith("/json/servers")) return Response.json([{ name: "de1.api.radio-browser.info" }]);
      return Response.json(raws);
    }) as typeof fetch;
    const list = await searchStations({ kind: "tag", value: "jazz" }, 5);
    const search = new URL(urls.find((u) => u.includes("/json/stations/search"))!);
    expect(search.searchParams.get("is_https")).toBe("true");
    expect(search.searchParams.get("hidebroken")).toBe("true");
    expect(search.searchParams.get("tag")).toBe("jazz");
    expect(search.searchParams.get("tagExact")).toBe("true");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => s.playable)).toBe(true);
  });
});

describe("ICY metadata", () => {
  test("parses StreamTitle and drops placeholders", () => {
    expect(parseStreamTitle("StreamTitle='Artist - Song';StreamUrl='';")).toBe("Artist - Song");
    expect(parseStreamTitle("StreamTitle='Don't Stop Me Now';")).toBe("Don't Stop Me Now");
    expect(parseStreamTitle("StreamTitle=' - ';")).toBe("");
    expect(parseStreamTitle("StreamTitle='4727 - 4727';")).toBe("");
    expect(parseStreamTitle("StreamUrl='x';")).toBe("");
  });

  test("reads the first metadata block after metaint audio bytes, across chunk boundaries", async () => {
    const metaint = 10;
    const meta = new TextEncoder().encode("StreamTitle='Björk - Jóga';");
    const padded = new Uint8Array(Math.ceil(meta.length / 16) * 16);
    padded.set(meta);
    const bytes = new Uint8Array([...new Uint8Array(metaint).fill(7), padded.length / 16, ...padded, 1, 2, 3]);
    // Deliver in awkward 3-byte chunks.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
    expect(parseStreamTitle(await readFirstBlock(body, metaint))).toBe("Björk - Jóga");
  });

  test("an empty metadata block reads as no title", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4, 0, 9, 9]));
        c.close();
      },
    });
    expect(await readFirstBlock(body, 4)).toBe("");
  });
});

describe("artwork fallback", () => {
  test("monogram is a deterministic SVG with an escaped initial", () => {
    const a = monogram("abc", "<script>");
    expect(a).toStartWith("<svg");
    expect(a).not.toContain("<script");
    expect(monogram("abc", "Radio")).toBe(monogram("abc", "Radio"));
  });
});
