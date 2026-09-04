import { describe, expect, test } from "bun:test";
import { fixtureNames, resolveGalleryFixtureSource } from "./gallery-fixtures";
import { audioExample } from "./components/audio";
import { cardExample } from "./components/card";
import { gridExample } from "./components/grid";
import { gridColumnsExample } from "./applicators/gridColumns";
import { imageExample } from "./components/image";
import { stackExample } from "./components/stack";
import { overflowExample } from "./applicators/overflow";
import { maxLinesExample } from "./applicators/maxLines";

describe("component gallery media fixtures", () => {
  test("tracks deterministic audio in screenshot readiness", () => {
    expect([...fixtureNames(audioExample.ui)]).toEqual(["sample.wav"]);
    expect(audioExample.ui).not.toContain("w3schools.com");
  });

  test("tracks the deterministic card image in screenshot readiness", () => {
    expect([...fixtureNames(cardExample.ui)]).toEqual(["card.png"]);
    expect(cardExample.ui).not.toContain("picsum.photos");
  });

  test("tracks deterministic Grid images in screenshot readiness", () => {
    expect([...fixtureNames(gridExample.ui)]).toEqual([
      "grid-1.png", "grid-2.png", "grid-3.png", "grid-4.png",
    ]);
    expect([...fixtureNames(gridColumnsExample.ui)]).toEqual([
      "grid-1.png", "grid-2.png", "grid-3.png", "grid-4.png", "grid-5.png", "grid-6.png",
    ]);
    expect(gridExample.ui).not.toContain("picsum.photos");
    expect(gridColumnsExample.ui).not.toContain("picsum.photos");
  });

  test("tracks deterministic image-gallery fixtures", () => {
    expect([...fixtureNames(imageExample.ui)]).toEqual([
      "image-200x150.png", "image-square-1.png", "image-square-2.png",
      "image-square-3.png", "image-300x200.png",
    ]);
    expect([...fixtureNames(stackExample.ui)]).toEqual(["image-300x200.png"]);
    expect([...fixtureNames(overflowExample.ui)]).toEqual(["image-300x200.png"]);
    expect([...fixtureNames(maxLinesExample.ui)]).toEqual([
      "image-120x80-1.png", "image-120x80-2.png",
    ]);
    for (const source of [imageExample.ui, stackExample.ui, overflowExample.ui, maxLinesExample.ui]) {
      expect(source).not.toContain("picsum.photos");
    }
  });

  test.each([
    ["ios", "http://127.0.0.1:4010"],
    ["android", "http://10.0.2.2:4010"],
  ])("resolves relative Grid fixtures for the %s native image loader", (platform, fixtureBase) => {
    const rendered = resolveGalleryFixtureSource(gridExample.ui, {
      fixtureBase,
      platform,
      example: "grid",
      generation: 42,
    });

    for (let index = 1; index <= 4; index++) {
      expect(rendered).toContain(
        `${fixtureBase}/fixtures/grid-${index}.png?platform=${platform}&example=grid&generation=42`,
      );
    }
    expect(rendered).not.toMatch(/src: ["']\/fixtures\//);
  });

  test("keeps explicitly templated fixture URLs single and tracked", () => {
    const rendered = resolveGalleryFixtureSource(cardExample.ui, {
      fixtureBase: "http://127.0.0.1:4010/",
      platform: "ios",
      example: "card",
      generation: 9,
    });

    expect(rendered).toContain(
      'http://127.0.0.1:4010/fixtures/card.png?platform=ios&example=card&generation=9',
    );
    expect(rendered).not.toContain("__HYPEN_GALLERY_");
    expect(rendered.match(/platform=ios/g)).toHaveLength(1);
  });

  test("keeps Raw Card intrinsic and makes all three styled Cards full width", () => {
    const cardDeclarations = cardExample.ui.split(/\bCard\s*\{/).slice(1);
    expect(cardDeclarations).toHaveLength(4);
    expect(cardDeclarations[0]).not.toContain(".fillMaxWidth(true)");
    for (const styledCard of cardDeclarations.slice(1)) {
      expect(styledCard).toContain(".fillMaxWidth(true)");
    }
  });
});
