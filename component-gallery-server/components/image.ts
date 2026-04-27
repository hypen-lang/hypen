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

  Image(src: "https://picsum.photos/200/150")
    .marginBottom(24)

  Text("Styled Images")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Image(src: "https://picsum.photos/100/100")
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
      Image(src: "https://picsum.photos/101/101")
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
      Image(src: "https://picsum.photos/102/102")
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

  Image(src: "https://picsum.photos/300/200")
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
