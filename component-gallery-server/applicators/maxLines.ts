/**
 * maxLines Applicator Example
 * Limits text to specified number of lines.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const maxLinesExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("maxLines Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Text truncation")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Text("maxLines(1)")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.")
          .maxLines(1)
          .fillMaxWidth(true)
      }
      .backgroundColor("#f0f0f0")
      .padding(12)
      .cornerRadius(4)
      .fillMaxWidth(true)
    }

    Column {
      Text("maxLines(2)")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.")
          .maxLines(2)
          .fillMaxWidth(true)
      }
      .backgroundColor("#f0f0f0")
      .padding(12)
      .cornerRadius(4)
      .fillMaxWidth(true)
    }

    Column {
      Text("maxLines(3)")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.")
          .maxLines(3)
          .fillMaxWidth(true)
      }
      .backgroundColor("#f0f0f0")
      .padding(12)
      .cornerRadius(4)
      .fillMaxWidth(true)
    }

    Column {
      Text("No limit")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.")
          .fillMaxWidth(true)
      }
      .backgroundColor("#e0e7ff")
      .padding(12)
      .cornerRadius(4)
      .fillMaxWidth(true)
    }
  }
  .gap(16)
  .marginBottom(24)

  Text("Card with truncated description")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-120x80-1.png?platform=__HYPEN_GALLERY_PLATFORM__&example=maxLines&generation=__HYPEN_GALLERY_GENERATION__")
        .fillMaxWidth(true)
        .height(80)
        .cornerRadius(8)
        .marginBottom(8)

      Text("Article Title")
        .fontWeight("600")
        .fontSize(14)
        .marginBottom(4)

      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.")
        .fontSize(12)
        .color("#666")
        .maxLines(2)
    }
    .backgroundColor("#fff")
    .padding(12)
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .width(175)

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-120x80-2.png?platform=__HYPEN_GALLERY_PLATFORM__&example=maxLines&generation=__HYPEN_GALLERY_GENERATION__")
        .fillMaxWidth(true)
        .height(80)
        .cornerRadius(8)
        .marginBottom(8)

      Text("Another Article")
        .fontWeight("600")
        .fontSize(14)
        .marginBottom(4)

      Text("Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.")
        .fontSize(12)
        .color("#666")
        .maxLines(2)
    }
    .backgroundColor("#fff")
    .padding(12)
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .width(175)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
