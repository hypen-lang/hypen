import { describe, expect, test } from "bun:test";

const root = import.meta.dir;

async function source(relativePath: string): Promise<string> {
  return Bun.file(`${root}/${relativePath}`).text();
}

function occurrences(input: string, fragment: string): number {
  return input.split(fragment).length - 1;
}

describe("example route shell contracts", () => {
  test("Calories bounds scroll content and protects every bottom nav", async () => {
    const files = [
      "calorie-counter/cloudflare/src/components/App.ts",
      "calorie-counter/typescript/server/components/App.ts",
    ];

    for (const file of files) {
      const app = await source(file);
      expect(app).toContain('tw("flex-1 w-full h-screen min-h-0 overflow-hidden bg-white")');
      expect(occurrences(app, 'tw("flex-1 h-full min-h-0 overflow-hidden bg-white")')).toBe(5);
      expect(occurrences(app, 'tw("shrink-0")')).toBe(5);
      expect(app).not.toContain("min-h-screen");
    }
  });
});
