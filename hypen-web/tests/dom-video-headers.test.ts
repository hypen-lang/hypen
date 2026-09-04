/**
 * DOM Video component — `headers` tiered fallback
 * (packages/web/src/dom/components/video.ts, docs/components/video.md)
 *
 * When `headers` is present the renderer fetches the stream itself. This
 * suite covers the tier decision on top of that fetch:
 *
 *   1. sniff the container from the first chunk(s) of the body stream
 *   2. MSE-streamable (fMP4 / WebM) + MediaSource available → pump chunks
 *      into a SourceBuffer so playback starts while downloading
 *   3. otherwise accumulate to a Blob, reusing the bytes already read
 *
 * MediaSource does not exist in the test runtime, so tier 2 is exercised
 * through the exported `__setMediaSourceForTests` seam with a fake.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { getVideoSurface } from "../packages/web/src/dom/components/video";
import {
  sniffContainer,
  __setMediaSourceForTests,
  type MediaSourceLike,
  type SourceBufferLike,
} from "../packages/web/src/dom/components/video";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { flushMicrotasks } from "./helpers";

ensureFakeDomGlobals();

// ============================================================================
// Renderer harness (same shape as dom-video.test.ts)
// ============================================================================

class RecordingEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.actions.push({ name, payload });
  }
  actionsNamed(name: string): Array<{ name: string; payload: any }> {
    return this.actions.filter((a) => a.name === name);
  }
}

function makeRenderer() {
  const container = document.createElement("div");
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { container, engine, renderer };
}

function createVideo(
  renderer: DOMRenderer,
  props: Record<string, any>,
  id = "vid"
): FakeElement {
  renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "create", id, elementType: "Video", props } as Patch,
    { type: "insert", parentId: "root-1", id } as Patch,
  ]);
  // A Video node is a positioned wrapper around the `<video>` surface
  // (Video v2 composition slots overlay the player inside it); the media
  // element is what these tests drive.
  const node = renderer.getNode(id) as unknown as FakeElement;
  return getVideoSurface(node as unknown as HTMLElement) as unknown as FakeElement;
}

// ============================================================================
// Byte builders (ISO-BMFF boxes / EBML magic)
// ============================================================================

function fourCC(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function pad(n: number): number[] {
  return new Array(n).fill(0);
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...fourCC(type), ...body];
}

function ftypBox(major: string, ...compat: string[]): number[] {
  return box("ftyp", fourCC(major), u32(0x200), ...compat.map(fourCC));
}

/** fMP4 detected via an fMP4-typical major brand (no moof needed yet). */
function fmp4BrandBytes(): Uint8Array {
  return new Uint8Array([...ftypBox("iso5", "iso6", "mp41")]);
}

/** fMP4 detected via ftyp(+init moov) followed by a moof fragment. */
function fmp4MoofBytes(): Uint8Array {
  return new Uint8Array([
    ...ftypBox("isom", "iso2", "avc1"),
    ...box("moov", pad(64)),
    ...box("moof", pad(24)),
    ...box("mdat", pad(48)),
  ]);
}

/** Plain progressive MP4: ftyp + moov + bare mdat, no moof anywhere. */
function progressiveMp4Bytes(): Uint8Array {
  return new Uint8Array([
    ...ftypBox("isom", "iso2", "avc1", "mp41"),
    ...box("moov", pad(128)),
    ...box("mdat", pad(64)),
  ]);
}

/** WebM: EBML magic followed by arbitrary payload. */
function webmBytes(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...pad(60)]);
}

function splitChunks(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks.filter((c) => c.length > 0);
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ============================================================================
// Fake fetch Response with a streaming body
// ============================================================================

interface StreamResponseOpts {
  status?: number;
  contentType?: string | null;
}

function makeStreamResponse(chunks: Uint8Array[], opts: StreamResponseOpts = {}) {
  const status = opts.status ?? 200;
  let index = 0;
  let cancelled = false;
  const state = {
    reads: 0,
    cancelled: () => cancelled,
    drained: () => index >= chunks.length,
  };
  const reader = {
    read: async () => {
      state.reads += 1;
      if (cancelled || index >= chunks.length) {
        return { done: true as const, value: undefined };
      }
      return { done: false as const, value: chunks[index++]! };
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? opts.contentType ?? null : null,
    },
    body: { getReader: () => reader },
    blob: async () => new Blob(chunks as unknown as BlobPart[]),
  };
  return { response, state };
}

// ============================================================================
// Fake MediaSource / SourceBuffer (seam implementation)
// ============================================================================

class FakeSourceBuffer implements SourceBufferLike {
  updating = false;
  appended: Uint8Array[] = [];
  removed: Array<[number, number]> = [];
  buffered = { length: 1, start: (_: number) => 0, end: (_: number) => 40 };
  /** Append-call indices (0-based) that throw QuotaExceededError once. */
  quotaFailAt = new Set<number>();
  private appendCalls = 0;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  appendBuffer(data: Uint8Array): void {
    const call = this.appendCalls++;
    if (this.quotaFailAt.has(call)) {
      this.quotaFailAt.delete(call);
      const err = new Error("quota exceeded");
      (err as any).name = "QuotaExceededError";
      (err as any).code = 22;
      throw err;
    }
    this.appended.push(new Uint8Array(data));
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.fire("updateend");
    });
  }

  remove(start: number, end: number): void {
    this.removed.push([start, end]);
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.fire("updateend");
    });
  }
}

class FakeMediaSource implements MediaSourceLike {
  static instances: FakeMediaSource[] = [];
  static probed: string[] = [];
  static supportedPredicate: (mime: string) => boolean = () => true;
  /** Applied to the next-created instance's first SourceBuffer. */
  static nextQuotaFailAt: number[] = [];

  static isTypeSupported(mime: string): boolean {
    FakeMediaSource.probed.push(mime);
    return FakeMediaSource.supportedPredicate(mime);
  }

  static reset(): void {
    FakeMediaSource.instances = [];
    FakeMediaSource.probed = [];
    FakeMediaSource.supportedPredicate = () => true;
    FakeMediaSource.nextQuotaFailAt = [];
  }

  readyState = "closed";
  sourceBuffers: FakeSourceBuffer[] = [];
  addedMimes: string[] = [];
  endOfStreamCalls = 0;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeMediaSource.instances.push(this);
    // A real MediaSource opens once the element attaches the object URL;
    // the fake opens on the next microtask.
    queueMicrotask(() => {
      if (this.readyState !== "closed") return;
      this.readyState = "open";
      for (const fn of [...(this.listeners.get("sourceopen") ?? [])]) fn();
    });
  }

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  addSourceBuffer(mime: string): FakeSourceBuffer {
    this.addedMimes.push(mime);
    const sb = new FakeSourceBuffer();
    if (this.sourceBuffers.length === 0) {
      sb.quotaFailAt = new Set(FakeMediaSource.nextQuotaFailAt);
    }
    this.sourceBuffers.push(sb);
    return sb;
  }

  endOfStream(): void {
    this.endOfStreamCalls += 1;
    this.readyState = "ended";
  }
}

function installFakeMediaSource(): void {
  __setMediaSourceForTests({
    MediaSource: FakeMediaSource as any,
    createObjectURL: () => `blob:fake-mse-${FakeMediaSource.instances.length}`,
  });
}

// ============================================================================
// Suite
// ============================================================================

const originalFetch = globalThis.fetch;

beforeEach(() => {
  ensureFakeDomGlobals();
  FakeMediaSource.reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setMediaSourceForTests(undefined);
});

describe("sniffContainer", () => {
  test("fMP4 via fMP4-typical major brand (iso5) sniffs positive", () => {
    expect(sniffContainer(fmp4BrandBytes())).toBe("fmp4");
  });

  test("fMP4 via generic brand + moof fragment sniffs positive", () => {
    expect(sniffContainer(fmp4MoofBytes())).toBe("fmp4");
  });

  test("styp segment start sniffs as fMP4", () => {
    const bytes = new Uint8Array([
      ...box("styp", fourCC("msdh"), u32(0), fourCC("msdh")),
      ...box("moof", pad(16)),
    ]);
    expect(sniffContainer(bytes)).toBe("fmp4");
  });

  test("progressive MP4 (ftyp + moov + bare mdat, no moof) sniffs negative", () => {
    expect(sniffContainer(progressiveMp4Bytes())).toBe("progressive-mp4");
  });

  test("moov-at-end progressive MP4 (ftyp then huge mdat) sniffs negative", () => {
    // mdat's size points far past the sniff window; the bare mdat alone
    // (media data outside any fragment) is the progressive tell.
    const bytes = new Uint8Array([
      ...ftypBox("isom", "iso2", "mp41"),
      ...u32(50_000_000),
      ...fourCC("mdat"),
      ...pad(32),
    ]);
    expect(sniffContainer(bytes)).toBe("progressive-mp4");
  });

  test("WebM EBML magic sniffs positive", () => {
    expect(sniffContainer(webmBytes())).toBe("webm");
  });

  test("garbage and short prefixes sniff unknown", () => {
    expect(sniffContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe("unknown");
    expect(sniffContainer(new Uint8Array([0x1a, 0x45]))).toBe("unknown");
    // Valid box syntax but not a media-leading box: still unknown.
    expect(
      sniffContainer(new Uint8Array([...u32(16), ...fourCC("free"), ...pad(8)]))
    ).toBe("unknown");
  });
});

describe("Video headers: MSE streaming tier", () => {
  test("fMP4 stream pumps chunks into a SourceBuffer and ends the stream", async () => {
    const bytes = fmp4MoofBytes();
    const chunks = splitChunks(bytes, [10, 30, 40]);
    const { response, state } = makeStreamResponse(chunks, {
      contentType: "video/mp4",
    });
    const fetchCalls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return response as unknown as Response;
    }) as typeof fetch;

    installFakeMediaSource();

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected-movie.mp4",
      headers: { Authorization: "Bearer token-123" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(100);

    // Single fetch, with the user's headers.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.init.headers).toEqual({ Authorization: "Bearer token-123" });

    // Element plays the MediaSource object URL — no blob buffering.
    expect(String((el as any).src)).toStartWith("blob:fake-mse-");

    const ms = FakeMediaSource.instances[0]!;
    expect(FakeMediaSource.instances.length).toBe(1);
    expect(ms.addedMimes.length).toBe(1);
    expect(ms.addedMimes[0]!).toStartWith("video/mp4");

    // Every byte of the stream (sniffed prefix included) reached the buffer.
    const sb = ms.sourceBuffers[0]!;
    expect(concatAll(sb.appended)).toEqual(bytes);
    expect(state.drained()).toBe(true);

    // Reader end → endOfStream.
    expect(ms.endOfStreamCalls).toBe(1);
    expect(engine.actionsNamed("playbackFailed").length).toBe(0);
    expect(el.dataset.hypenVideoError).toBeUndefined();
  });

  test("WebM stream selects a webm MIME probe and streams via MSE", async () => {
    const bytes = webmBytes();
    const { response } = makeStreamResponse(splitChunks(bytes, [16, 16]));
    globalThis.fetch = (async () => response as unknown as Response) as typeof fetch;

    installFakeMediaSource();
    FakeMediaSource.supportedPredicate = (mime) => mime.startsWith("video/webm");

    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.webm",
      headers: { Authorization: "Bearer t" },
    });

    await flushMicrotasks(100);

    const ms = FakeMediaSource.instances[0]!;
    expect(String((el as any).src)).toStartWith("blob:fake-mse-");
    expect(ms.addedMimes[0]!).toStartWith("video/webm");
    expect(concatAll(ms.sourceBuffers[0]!.appended)).toEqual(bytes);
    expect(ms.endOfStreamCalls).toBe(1);
  });

  test("quota-exceeded append evicts already-played range and retries", async () => {
    const bytes = fmp4MoofBytes();
    const chunks = splitChunks(bytes, [20, 20, 20, 20]);
    const { response } = makeStreamResponse(chunks);
    globalThis.fetch = (async () => response as unknown as Response) as typeof fetch;

    installFakeMediaSource();
    FakeMediaSource.nextQuotaFailAt = [2]; // third append throws quota, once

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected-movie.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });
    // Simulate a viewer 30s into playback when quota hits.
    (el as any).currentTime = 30;

    await flushMicrotasks(200);

    const ms = FakeMediaSource.instances[0]!;
    const sb = ms.sourceBuffers[0]!;

    // Already-played media was removed: [buffered.start(0), currentTime - keepBehind].
    expect(sb.removed.length).toBe(1);
    expect(sb.removed[0]![0]).toBe(0);
    expect(sb.removed[0]![1]).toBe(27);

    // The quota-blocked chunk was retried — nothing lost, stream completed.
    expect(concatAll(sb.appended)).toEqual(bytes);
    expect(ms.endOfStreamCalls).toBe(1);
    expect(engine.actionsNamed("playbackFailed").length).toBe(0);
  });

  test("quota with nothing evictable surfaces onError with code, no status", async () => {
    const bytes = fmp4MoofBytes();
    const { response } = makeStreamResponse(splitChunks(bytes, [20, 20]));
    globalThis.fetch = (async () => response as unknown as Response) as typeof fetch;

    installFakeMediaSource();
    FakeMediaSource.nextQuotaFailAt = [1];

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected-movie.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });
    // currentTime stays 0/undefined → nothing already played → eviction
    // impossible → mid-stream pump failure per contract mode 3.

    await flushMicrotasks(100);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBeUndefined();
    expect(errors[0]!.payload.code).toBe(22);
    expect(errors[0]!.payload.message).toBe("quota exceeded");
    expect(errors[0]!.payload.src).toBe("https://cdn/protected-movie.mp4");
    expect(el.dataset.hypenVideoError).toBe("true");
  });
});

describe("Video headers: blob fallback tier", () => {
  test("progressive MP4 falls back to blob, reusing the prefetched bytes", async () => {
    const bytes = progressiveMp4Bytes();
    const chunks = splitChunks(bytes, [24, 100, 60]);
    const { response, state } = makeStreamResponse(chunks, {
      contentType: "video/mp4",
    });
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      fetchCalls.push(String(url));
      return response as unknown as Response;
    }) as typeof fetch;

    // MediaSource IS available and claims support — the container sniff
    // alone must force the blob tier.
    installFakeMediaSource();

    // Capture the Blob handed to createObjectURL to prove byte reuse.
    const originalCreate = URL.createObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as any).createObjectURL = (obj: any) => {
      capturedBlob = obj;
      return "blob:captured";
    };

    try {
      const { renderer, engine } = makeRenderer();
      const el = createVideo(renderer, {
        src: "https://cdn/protected.mp4",
        headers: { Authorization: "Bearer token-123" },
        onError: "@actions.playbackFailed",
      });

      await flushMicrotasks(50);

      // ONE fetch — the sniffed prefix was reused, never refetched.
      expect(fetchCalls).toEqual(["https://cdn/protected.mp4"]);
      expect(state.drained()).toBe(true);

      // No MSE attempt for a progressive container.
      expect(FakeMediaSource.instances.length).toBe(0);

      expect(String((el as any).src)).toBe("blob:captured");
      expect(capturedBlob).not.toBeNull();
      const buffered = new Uint8Array(await capturedBlob!.arrayBuffer());
      expect(buffered).toEqual(bytes);
      expect(capturedBlob!.type).toStartWith("video/mp4");

      expect(engine.actionsNamed("playbackFailed").length).toBe(0);
    } finally {
      (URL as any).createObjectURL = originalCreate;
    }
  });

  test("streamable container but no MediaSource → blob fallback, no refetch", async () => {
    const bytes = fmp4MoofBytes();
    const { response, state } = makeStreamResponse(splitChunks(bytes, [40, 60]));
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      fetchCalls.push(String(url));
      return response as unknown as Response;
    }) as typeof fetch;

    __setMediaSourceForTests(null); // platform without MSE

    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer t" },
    });

    await flushMicrotasks(50);

    expect(fetchCalls.length).toBe(1);
    expect(state.drained()).toBe(true);
    expect(String((el as any).src)).toStartWith("blob:");
  });

  test("isTypeSupported rejecting every probe → blob fallback", async () => {
    const bytes = fmp4MoofBytes();
    const { response, state } = makeStreamResponse(splitChunks(bytes, [40, 60]));
    globalThis.fetch = (async () => response as unknown as Response) as typeof fetch;

    installFakeMediaSource();
    FakeMediaSource.supportedPredicate = () => false;

    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer t" },
    });

    await flushMicrotasks(50);

    // Probes ran, none accepted, no MediaSource constructed, blob assigned.
    expect(FakeMediaSource.probed.length).toBeGreaterThan(0);
    expect(FakeMediaSource.instances.length).toBe(0);
    expect(state.drained()).toBe(true);
    expect(String((el as any).src)).toStartWith("blob:");
  });
});

describe("Video headers: failure semantics unchanged", () => {
  test("403 dispatches onError with status; body never touched", async () => {
    const { response, state } = makeStreamResponse(
      splitChunks(fmp4MoofBytes(), [40]),
      { status: 403 }
    );
    globalThis.fetch = (async () => response as unknown as Response) as typeof fetch;

    installFakeMediaSource();

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer expired" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(20);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload).toEqual({
      type: "error",
      src: "https://cdn/protected.mp4",
      index: 0,
      status: 403,
      message: "HTTP 403 while fetching video source",
    });

    expect((el as any).src).toBeUndefined();
    expect(el.dataset.hypenVideoError).toBe("true");
    expect(state.reads).toBe(0);
    expect(FakeMediaSource.instances.length).toBe(0);
  });

  test("network error during fetch dispatches onError without status", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    installFakeMediaSource();

    const { renderer, engine } = makeRenderer();
    createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(20);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBeUndefined();
    expect(errors[0]!.payload.message).toBe("Failed to fetch");
  });

  test("mid-stream read failure during blob accumulation → onError, no status", async () => {
    const chunks = splitChunks(progressiveMp4Bytes(), [24, 60]);
    let reads = 0;
    const reader = {
      read: async () => {
        reads += 1;
        if (reads <= 2) return { done: false as const, value: chunks[reads - 1]! };
        throw new TypeError("network reset mid-stream");
      },
      cancel: async () => {},
    };
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => reader },
        blob: async () => new Blob([]),
      }) as unknown as Response) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(30);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBeUndefined();
    expect(errors[0]!.payload.message).toBe("network reset mid-stream");
    expect(el.dataset.hypenVideoError).toBe("true");
  });

  test("source change mid-pump aborts the old stream (reader cancelled)", async () => {
    const bytes = fmp4MoofBytes();
    // Endless stream: repeats media chunks forever until cancelled.
    let cancelled = false;
    let offset = 0;
    const reader = {
      read: async () => {
        if (cancelled) return { done: true as const, value: undefined };
        const chunk = bytes.slice(offset % bytes.length, (offset % bytes.length) + 20);
        offset += 20;
        return { done: false as const, value: chunk.length ? chunk : bytes.slice(0, 20) };
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => "video/mp4" },
        body: { getReader: () => reader },
        blob: async () => new Blob([]),
      }) as unknown as Response) as typeof fetch;

    installFakeMediaSource();

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected-live.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(40);
    expect(String((el as any).src)).toStartWith("blob:fake-mse-");
    expect(cancelled).toBe(false);

    // Source change: headers removed → direct native path for the new URL.
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "headers", value: {} } as Patch,
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/public.mp4" } as Patch,
    ]);

    await flushMicrotasks(40);

    expect(cancelled).toBe(true); // old pump's reader was cancelled
    expect((el as any).src).toBe("https://cdn/public.mp4");
    // The superseded pump neither errored nor ended the (stale) MediaSource.
    expect(engine.actionsNamed("playbackFailed").length).toBe(0);
    expect(FakeMediaSource.instances[0]!.endOfStreamCalls).toBe(0);
  });
});
