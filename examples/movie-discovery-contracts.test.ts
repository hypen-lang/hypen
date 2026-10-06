import { describe, expect, test } from "bun:test";

const root = import.meta.dir;

async function source(relativePath: string): Promise<string> {
  return Bun.file(`${root}/${relativePath}`).text();
}

describe("MovieDB detail action contracts", () => {
  test("the full watchlist CTA declares full width on every server", async () => {
    const files = [
      "movie-discovery/cloudflare/src/components/MovieDetail.ts",
      "movie-discovery/typescript/server/components/MovieDetail.ts",
    ];

    for (const file of files) {
      const detail = await source(file);
      expect(detail).toMatch(
        /\.tw\("mt-6 h-1[24] rounded-2xl border-0 items-center justify-center"\)\s*(?:\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*)?\.width\("100%"\)/,
      );
    }
  });

  test("the separate header bookmark stays an icon-sized control", async () => {
    const detail = await source("movie-discovery/cloudflare/src/components/MovieDetail.ts");
    expect(detail).toContain('tw("w-10 h-10 rounded-full border items-center justify-center")');
  });
});
