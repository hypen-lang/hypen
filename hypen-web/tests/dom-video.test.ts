/**
 * DOM Video component — cross-platform Video contract
 * (packages/web/src/dom/components/video.ts, docs/components/video.md)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { getVideoSurface } from "../packages/web/src/dom/components/video";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { flushMicrotasks } from "./helpers";

ensureFakeDomGlobals();

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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  ensureFakeDomGlobals();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Video: SetProp routing (COMPONENT_HTML_ATTRS fix)", () => {
  test("src arriving in a later SetProp reaches the element", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {});

    expect((el as any).src).toBeUndefined();

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/movie.mp4" } as Patch,
    ]);

    expect((el as any).src).toBe("https://cdn/movie.mp4");
    expect(el.dataset.hypenVideoPlaceholder).toBeUndefined();
  });

  test("positional '0' SetProp routes to the handler, not textContent", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {});

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "0", value: "https://cdn/clip.mp4" } as Patch,
    ]);

    expect((el as any).src).toBe("https://cdn/clip.mp4");
    expect(el.textContent).toBe("");
  });

  test("controls/muted/poster SetProps reach the element", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, { src: "https://cdn/a.mp4" });

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "controls", value: true } as Patch,
      { type: "setProp", id: "vid", name: "muted", value: true } as Patch,
      { type: "setProp", id: "vid", name: "poster", value: "https://cdn/p.jpg" } as Patch,
    ]);

    expect((el as any).controls).toBe(true);
    expect((el as any).muted).toBe(true);
    expect((el as any).poster).toBe("https://cdn/p.jpg");
  });
});

describe("Video: simple props (backward compat)", () => {
  test("plain Video(src:, controls:) works unchanged", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/movie.mp4",
      controls: true,
      loop: true,
      muted: true,
    });

    expect((el as any).src).toBe("https://cdn/movie.mp4");
    expect((el as any).controls).toBe(true);
    expect((el as any).loop).toBe(true);
    expect((el as any).muted).toBe(true);
  });

  test("preload defaults to metadata and can be overridden", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {});
    expect((el as any).preload).toBe("metadata");

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "preload", value: "auto" } as Patch,
    ]);
    expect((el as any).preload).toBe("auto");
  });

  test("no src renders placeholder without crash or dispatch", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, { controls: true });

    expect(el.dataset.hypenVideoPlaceholder).toBe("true");
    expect((el as any).src).toBeUndefined();
    expect(engine.actions.length).toBe(0);
  });
});

describe("Video: playlist", () => {
  test("playlist supersedes src and starts at startIndex (clamped)", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/single.mp4",
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
      startIndex: 5, // clamped to last valid index
    });

    expect((el as any).src).toBe("https://cdn/ep2.mp4");
    // Native loop must stay off while a playlist drives playback
    expect((el as any).loop).toBe(false);
  });

  test("ended advances the queue and dispatches onEnded + onTrackChange", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
      onTrackChange: "@actions.trackChanged",
      onEnded: "@actions.playbackDone",
    });

    expect((el as any).src).toBe("https://cdn/ep1.mp4");

    el.dispatchEvent("ended");

    expect((el as any).src).toBe("https://cdn/ep2.mp4");

    const ended = engine.actionsNamed("playbackDone");
    expect(ended.length).toBe(1);
    expect(ended[0]!.payload).toEqual({
      type: "ended",
      src: "https://cdn/ep1.mp4",
      index: 0,
      completed: false,
    });

    const track = engine.actionsNamed("trackChanged");
    expect(track.length).toBe(1);
    expect(track[0]!.payload).toEqual({
      type: "trackchange",
      src: "https://cdn/ep2.mp4",
      index: 1,
    });
  });

  test("last track ends with completed: true and no further advance", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
      onEnded: "@actions.playbackDone",
      onTrackChange: "@actions.trackChanged",
    });

    el.dispatchEvent("ended"); // ep1 -> ep2
    el.dispatchEvent("ended"); // ep2 done

    const ended = engine.actionsNamed("playbackDone");
    expect(ended.length).toBe(2);
    expect(ended[1]!.payload).toEqual({
      type: "ended",
      src: "https://cdn/ep2.mp4",
      index: 1,
      completed: true,
    });

    // No wrap without loop: still on the last track, one trackchange total.
    expect((el as any).src).toBe("https://cdn/ep2.mp4");
    expect(engine.actionsNamed("trackChanged").length).toBe(1);
  });

  test("loop wraps the queue to track 0 with completed: false", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
      loop: true,
      onEnded: "@actions.playbackDone",
      onTrackChange: "@actions.trackChanged",
    });

    // Playlist mode keeps the native loop flag off even with loop: true
    expect((el as any).loop).toBe(false);

    el.dispatchEvent("ended"); // ep1 -> ep2
    el.dispatchEvent("ended"); // ep2 -> wrap to ep1

    expect((el as any).src).toBe("https://cdn/ep1.mp4");

    const ended = engine.actionsNamed("playbackDone");
    expect(ended[1]!.payload.completed).toBe(false);

    const track = engine.actionsNamed("trackChanged");
    expect(track.length).toBe(2);
    expect(track[1]!.payload).toEqual({
      type: "trackchange",
      src: "https://cdn/ep1.mp4",
      index: 0,
    });
  });

  test("playlist accepts Map-shaped values (WASM decoding)", () => {
    const { renderer } = makeRenderer();
    const el = createVideo(renderer, {
      playlist: new Map<string, any>([
        ["0", "https://cdn/a.mp4"],
        ["1", "https://cdn/b.mp4"],
      ]),
    });

    expect((el as any).src).toBe("https://cdn/a.mp4");
    el.dispatchEvent("ended");
    expect((el as any).src).toBe("https://cdn/b.mp4");
  });
});

describe("Video: onPlay / onPause", () => {
  test("play and pause dispatch contract payloads", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/movie.mp4",
      onPlay: "@actions.played",
      onPause: "@actions.paused",
    });

    el.dispatchEvent("play");
    el.dispatchEvent("pause");

    expect(engine.actionsNamed("played")[0]!.payload).toEqual({
      type: "play",
      src: "https://cdn/movie.mp4",
      index: 0,
    });
    expect(engine.actionsNamed("paused")[0]!.payload).toEqual({
      type: "pause",
      src: "https://cdn/movie.mp4",
      index: 0,
    });
  });

  test("re-applied action props retarget instead of stacking listeners", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/movie.mp4",
      onPlay: "@actions.first",
    });

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "onPlay", value: "@actions.second" } as Patch,
    ]);

    el.dispatchEvent("play");

    expect(engine.actionsNamed("first").length).toBe(0);
    const second = engine.actionsNamed("second");
    expect(second.length).toBe(1); // one listener, retargeted — no stacking
  });
});

describe("Video: onError", () => {
  test("MediaError triggers ranged probe; HTTP status lands in the payload", async () => {
    const fetchCalls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return { ok: false, status: 403 } as Response;
    }) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      onError: "@actions.playbackFailed",
    });

    (el as any).error = { code: 4, message: "MEDIA_ELEMENT_ERROR: Format error" };
    el.dispatchEvent("error");
    await flushMicrotasks(5);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload).toEqual({
      type: "error",
      src: "https://cdn/protected.mp4",
      index: 0,
      status: 403,
      code: 4,
      message: "MEDIA_ELEMENT_ERROR: Format error",
    });

    // 1-byte ranged probe with Range header
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://cdn/protected.mp4");
    expect(fetchCalls[0]!.init.headers.Range).toBe("bytes=0-0");

    // Quiet error state: data attribute + dark background
    expect(el.dataset.hypenVideoError).toBe("true");
    expect(el.style.getPropertyValue("background-color")).toBe("#000");
  });

  test("probe failure (CORS/network) omits status", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/movie.mp4",
      onError: "@actions.playbackFailed",
    });

    (el as any).error = { code: 2, message: "network error" };
    el.dispatchEvent("error");
    await flushMicrotasks(5);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBeUndefined();
    expect(errors[0]!.payload.code).toBe(2);
    expect(errors[0]!.payload.message).toBe("network error");
  });
});

describe("Video: headers -> blob fallback", () => {
  test("headers present: fetch with headers, assign object URL", async () => {
    const fetchCalls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["fake-bytes"], { type: "video/mp4" }),
      } as unknown as Response;
    }) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer token-123" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(5);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://cdn/protected.mp4");
    expect(fetchCalls[0]!.init.headers).toEqual({ Authorization: "Bearer token-123" });

    expect(String((el as any).src)).toStartWith("blob:");
    expect(engine.actionsNamed("playbackFailed").length).toBe(0);
  });

  test("headers fetch HTTP failure dispatches onError with status", async () => {
    globalThis.fetch = (async () => {
      return { ok: false, status: 401 } as Response;
    }) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {
      src: "https://cdn/protected.mp4",
      headers: { Authorization: "Bearer expired" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(5);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBe(401);
    expect(errors[0]!.payload.src).toBe("https://cdn/protected.mp4");
    expect(errors[0]!.payload.type).toBe("error");
    expect((el as any).src).toBeUndefined();
    expect(el.dataset.hypenVideoError).toBe("true");
  });

  test("headers fetch network failure dispatches onError without status", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const { renderer, engine } = makeRenderer();
    createVideo(renderer, {
      src: "https://cdn/movie.mp4",
      headers: { Authorization: "Bearer t" },
      onError: "@actions.playbackFailed",
    });

    await flushMicrotasks(5);

    const errors = engine.actionsNamed("playbackFailed");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.status).toBeUndefined();
    expect(errors[0]!.payload.message).toBe("Failed to fetch");
  });
});

describe("Video: '.0'-suffixed prop variants", () => {
  test("suffixed names route and apply like plain names", () => {
    const { renderer, engine } = makeRenderer();
    const el = createVideo(renderer, {});

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src.0", value: "https://cdn/movie.mp4" } as Patch,
      { type: "setProp", id: "vid", name: "controls.0", value: true } as Patch,
      { type: "setProp", id: "vid", name: "onPlay.0", value: "@actions.played" } as Patch,
    ]);

    expect((el as any).src).toBe("https://cdn/movie.mp4");
    expect((el as any).controls).toBe(true);

    el.dispatchEvent("play");
    expect(engine.actionsNamed("played").length).toBe(1);
  });
});
