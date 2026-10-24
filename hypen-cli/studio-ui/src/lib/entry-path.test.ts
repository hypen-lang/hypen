import { describe, expect, test } from "bun:test";
import { entryFilePath } from "./entry-path";

describe("entryFilePath", () => {
  test("uses the configured components directory", () => {
    expect(entryFilePath({ components: "./src/ui", entry: "Home" })).toBe("src/ui/Home/component.hypen");
    expect(entryFilePath({ components: "./src/components/", entry: "App" })).toBe(
      "src/components/App/component.hypen",
    );
  });

  test("defaults to src/components and App", () => {
    expect(entryFilePath({})).toBe("src/components/App/component.hypen");
  });

  test("opens the entry script for server-based projects", () => {
    expect(entryFilePath({ components: "./src/components", entry: "./src/app.ts" })).toBe("src/app.ts");
  });
});
