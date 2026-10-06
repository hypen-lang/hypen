import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registeredGalleryDeeplinks } from "./gallery-registry";

describe("registeredGalleryDeeplinks", () => {
  test("uses the registries and de-duplicates deeplinks", () => {
    const root = mkdtempSync(join(tmpdir(), "hypen-gallery-registry-"));
    try {
      writeFileSync(join(root, "components.json"), JSON.stringify([
        { name: "Row", deeplink: "row" },
        { name: "Column", deeplink: "column" },
      ]));
      writeFileSync(join(root, "applicators.json"), JSON.stringify([
        { name: "Gap", deeplink: "gap" },
        { name: "Duplicate row", deeplink: "row" },
      ]));

      expect(registeredGalleryDeeplinks(root)).toEqual(["column", "gap", "row"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed registry entries", () => {
    const root = mkdtempSync(join(tmpdir(), "hypen-gallery-registry-"));
    try {
      writeFileSync(join(root, "components.json"), JSON.stringify([{ name: "Missing" }]));
      writeFileSync(join(root, "applicators.json"), "[]");
      expect(() => registeredGalleryDeeplinks(root)).toThrow("Invalid gallery registry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
