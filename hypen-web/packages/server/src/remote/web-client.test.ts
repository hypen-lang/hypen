import { describe, expect, test } from "bun:test";
import { statSync, utimesSync, readFileSync } from "fs";
import {
  __webClientInternals,
  getWebClientBundle,
  renderClientHtml,
  renderFallbackHtml,
} from "./web-client.ts";

describe("web-client HTML shells", () => {
  // Without an explicit icon the browser requests /favicon.ico, which the
  // RemoteServer (and `hypen dev`, which serves this shell) answers with 404,
  // leaving a console error on every page load.
  test("declare an inline favicon so the browser does not request /favicon.ico", () => {
    expect(renderClientHtml()).toContain('<link rel="icon" href="data:,">');
    expect(renderFallbackHtml("ws://localhost:3000")).toContain('<link rel="icon" href="data:,">');
  });
});

describe("web-client bundle freshness (source checkout)", () => {
  test("running from src, the bundle's source dirs (server, core, web) are found", () => {
    const dirs = __webClientInternals.checkoutSourceDirs();
    expect(dirs.some((d) => d.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/core/src"))).toBe(true);
    expect(dirs.some((d) => d.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/web/src"))).toBe(true);
    expect(__webClientInternals.newestSourceMtime(dirs)).toBeGreaterThan(0);
  });

  test(
    "a prebuilt bundle older than its sources is not served; the client is bundled from src",
    async () => {
      const prebuilt = __webClientInternals.findPrebuiltBundle();
      if (!prebuilt) return; // no dist in this checkout: src is bundled anyway
      const { atime, mtime } = statSync(prebuilt);
      const stale = readFileSync(prebuilt, "utf-8");
      try {
        // Make the artifact older than every source.
        utimesSync(prebuilt, new Date(0), new Date(0));
        __webClientInternals.reset();
        const served = await getWebClientBundle();
        expect(served).not.toBeNull();
        expect(served).not.toBe(stale);
      } finally {
        utimesSync(prebuilt, atime, mtime);
        __webClientInternals.reset();
      }
    },
    60_000
  );
});
