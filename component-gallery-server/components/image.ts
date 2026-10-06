/**
 * Image Component Example
 * Displays images with various styling options.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const imageExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Image Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Image")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-200x150.png?platform=__HYPEN_GALLERY_PLATFORM__&example=image&generation=__HYPEN_GALLERY_GENERATION__")
    .marginBottom(24)

  Text("Styled Images")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-square-1.png?platform=__HYPEN_GALLERY_PLATFORM__&example=image&generation=__HYPEN_GALLERY_GENERATION__")
        .width(100)
        .height(100)
        .cornerRadius(8)
      Text("Rounded")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-square-2.png?platform=__HYPEN_GALLERY_PLATFORM__&example=image&generation=__HYPEN_GALLERY_GENERATION__")
        .width(100)
        .height(100)
        .cornerRadius(50)
      Text("Circle")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-square-3.png?platform=__HYPEN_GALLERY_PLATFORM__&example=image&generation=__HYPEN_GALLERY_GENERATION__")
        .width(100)
        .height(100)
        .border({width: 3, color: "#3b82f6"})
        .cornerRadius(8)
      Text("Bordered")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(16)
  .marginBottom(24)

  Text("Large Image with Shadow")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-300x200.png?platform=__HYPEN_GALLERY_PLATFORM__&example=image&generation=__HYPEN_GALLERY_GENERATION__")
    .width(300)
    .height(200)
    .cornerRadius(12)
    .shadow({x: 0, y: 4, blur: 12, color: "rgba(0,0,0,0.15)"})
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
.horizontalAlignment("center")
`
};
