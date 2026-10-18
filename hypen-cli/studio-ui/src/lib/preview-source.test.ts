import { describe, expect, test } from "bun:test";
import { pickPreviewSource, studioEngineWsUrl } from "./preview-source";

const loc = { protocol: "http:", host: "localhost:5173" };

describe("studioEngineWsUrl", () => {
  test("maps http/https pages to ws/wss on the same host", () => {
    expect(studioEngineWsUrl(loc)).toBe("ws://localhost:5173/ws/engine");
    expect(studioEngineWsUrl({ protocol: "https:", host: "studio.dev" })).toBe(
      "wss://studio.dev/ws/engine"
    );
  });
});

describe("pickPreviewSource", () => {
  test("streams from the studio engine once it is ready (real module handlers)", () => {
    expect(pickPreviewSource({ ready: true, state: "ready" }, loc)).toEqual({
      kind: "remote",
      url: "ws://localhost:5173/ws/engine",
      external: false,
    });
  });

  test("an external server (server-based project) wins", () => {
    expect(
      pickPreviewSource({ state: "unavailable", remoteUrl: "ws://localhost:3000" }, loc)
    ).toEqual({ kind: "remote", url: "ws://localhost:3000", external: true });
  });

  test("keeps polling while the engine is starting", () => {
    expect(pickPreviewSource({ ready: false, state: "starting" }, loc)).toBeNull();
    expect(pickPreviewSource(null, loc)).toBeNull();
  });

  test("falls back to the in-browser preview when the engine can't serve", () => {
    expect(pickPreviewSource({ state: "unavailable", reason: "no components directory" }, loc)).toEqual({
      kind: "local",
      reason: "no components directory",
    });
    expect(pickPreviewSource({ state: "starting" }, loc, true)?.kind).toBe("local");
    expect(pickPreviewSource(null, loc, true)?.kind).toBe("local");
  });

  test("older studio servers that only report `ready` still connect", () => {
    expect(pickPreviewSource({ ready: true }, loc)?.kind).toBe("remote");
  });
});
