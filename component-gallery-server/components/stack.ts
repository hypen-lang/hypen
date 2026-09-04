/**
 * Stack Component Example
 * Overlays children on top of each other.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const stackExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Stack Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Stack")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("Background")
    }
    .backgroundColor("#e0e7ff")
    .width(200)
    .height(100)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Column {
      Text("Foreground")
        .color("#fff")
    }
    .backgroundColor("#6366f1")
    .padding(8)
    .cornerRadius(4)
  }
  .marginBottom(24)

  Text("Styled Stack - Centered Overlay")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-300x200.png?platform=__HYPEN_GALLERY_PLATFORM__&example=stack&generation=__HYPEN_GALLERY_GENERATION__")
      .width(300)
      .height(200)
      .cornerRadius(12)

    Column {
      Text("Centered Title")
        .color("#fff")
        .fontSize(18)
        .fontWeight("600")
      Text("Subtitle text")
        .color("rgba(255,255,255,0.8)")
        .fontSize(14)
    }
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .width(300)
  .height(200)
  .alignment("center")
  .cornerRadius(12)
  .overflow("hidden")
  .marginBottom(24)

  Text("Stack - Simple Badge")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("Inbox")
        .fontWeight("500")
    }
    .backgroundColor("#f3f4f6")
    .padding(16)
    .paddingHorizontal(24)
    .cornerRadius(8)

    Column {
      Text("3")
        .color("#fff")
        .fontSize(12)
        .fontWeight("600")
    }
    .backgroundColor("#ef4444")
    .width(20)
    .height(20)
    .cornerRadius(10)
    .horizontalAlignment("center")
    .verticalAlignment("center")
    .marginLeft(-10)
    .marginTop(-10)
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
