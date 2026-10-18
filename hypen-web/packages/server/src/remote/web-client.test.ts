import { describe, expect, test } from "bun:test";
import { renderClientHtml, renderFallbackHtml } from "./web-client.ts";

describe("web-client HTML shells", () => {
  // Without an explicit icon the browser requests /favicon.ico, which the
  // RemoteServer (and `hypen dev`, which serves this shell) answers with 404,
  // leaving a console error on every page load.
  test("declare an inline favicon so the browser does not request /favicon.ico", () => {
    expect(renderClientHtml()).toContain('<link rel="icon" href="data:,">');
    expect(renderFallbackHtml("ws://localhost:3000")).toContain('<link rel="icon" href="data:,">');
  });
});
