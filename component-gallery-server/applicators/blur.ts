/**
 * blur Applicator Example
 * Applies blur filter to elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const blurExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("blur Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Blur amounts")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/blur.png?platform=__HYPEN_GALLERY_PLATFORM__&example=blur&generation=__HYPEN_GALLERY_GENERATION__")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .blur(0)
      Text("blur(0)")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/blur.png?platform=__HYPEN_GALLERY_PLATFORM__&example=blur&generation=__HYPEN_GALLERY_GENERATION__")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .blur(2)
      Text("blur(2)")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/blur.png?platform=__HYPEN_GALLERY_PLATFORM__&example=blur&generation=__HYPEN_GALLERY_GENERATION__")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .blur(4)
      Text("blur(4)")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/blur.png?platform=__HYPEN_GALLERY_PLATFORM__&example=blur&generation=__HYPEN_GALLERY_GENERATION__")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .blur(8)
      Text("blur(8)")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Blur on text/content")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Clear")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .color("#fff")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Blurred")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .color("#fff")
    .padding(16)
    .cornerRadius(8)
    .blur(2)

    Stack {
      Text("Very Blurred")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .color("#fff")
    .padding(16)
    .cornerRadius(8)
    .blur(5)
  }
  .gap(12)
  .marginBottom(24)

  Text("Blur for loading/skeleton")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Stack {}
        .backgroundColor("#e5e7eb")
        .width(48)
        .height(48)
        .cornerRadius(24)
        .blur(1)

      Column {
        Stack {}
          .backgroundColor("#e5e7eb")
          .height(16)
          .width(120)
          .cornerRadius(4)
          .blur(1)
        Stack {}
          .backgroundColor("#e5e7eb")
          .height(12)
          .width(80)
          .cornerRadius(4)
          .blur(1)
      }
      .gap(8)
    }
    .gap(12)
    .horizontalAlignment("center")

    Stack {}
      .backgroundColor("#e5e7eb")
      .height(12)
      .fillMaxWidth(true)
      .cornerRadius(4)
      .blur(1)

    Stack {}
      .backgroundColor("#e5e7eb")
      .height(12)
      .width("80%")
      .cornerRadius(4)
      .blur(1)
  }
  .gap(12)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
