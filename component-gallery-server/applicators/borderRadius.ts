/**
 * borderRadius Applicator Example
 * Rounds the corners of elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const borderRadiusExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("borderRadius Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Different radius values")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("0")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .size(64)
      .borderRadius(0)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("0px")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("4")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .size(64)
      .borderRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("4px")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("8")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .size(64)
      .borderRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("8px")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("16")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .size(64)
      .borderRadius(16)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("16px")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("32")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .size(64)
      .borderRadius(32)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("Circle")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("With borders")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("R4")
        .fontSize(12)
    }
    .border({width: 2, color: "#3b82f6"})
    .padding(16)
    .borderRadius(4)

    Stack {
      Text("R12")
        .fontSize(12)
    }
    .border({width: 2, color: "#22c55e"})
    .padding(16)
    .borderRadius(12)

    Stack {
      Text("R24")
        .fontSize(12)
    }
    .border({width: 2, color: "#f59e0b"})
    .padding(16)
    .borderRadius(24)
  }
  .gap(12)
  .marginBottom(24)

  Text("Rounded images")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/rounded-image-1.png?platform=__HYPEN_GALLERY_PLATFORM__&example=borderRadius&generation=__HYPEN_GALLERY_GENERATION__")
      .width(80)
      .height(80)
      .borderRadius(0)

    Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/rounded-image-2.png?platform=__HYPEN_GALLERY_PLATFORM__&example=borderRadius&generation=__HYPEN_GALLERY_GENERATION__")
      .width(80)
      .height(80)
      .borderRadius(12)

    Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/rounded-image-3.png?platform=__HYPEN_GALLERY_PLATFORM__&example=borderRadius&generation=__HYPEN_GALLERY_GENERATION__")
      .width(80)
      .height(80)
      .borderRadius(40)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
