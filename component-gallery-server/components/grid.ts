/**
 * Grid Component Example
 * CSS Grid-based layout container.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const gridExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Grid Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Grid (2 columns)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Text("1")
    Text("2")
    Text("3")
    Text("4")
  }
  .gridColumns(2)
  .gap(8)
  .marginBottom(24)

  Text("Styled Grid (3 columns)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Column {
      Text("A")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")

    Column {
      Text("B")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#22c55e")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")

    Column {
      Text("C")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#f59e0b")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")

    Column {
      Text("D")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#ef4444")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")

    Column {
      Text("E")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#8b5cf6")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")

    Column {
      Text("F")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#ec4899")
    .padding(24)
    .cornerRadius(8)
    .horizontalAlignment("center")
  }
  .gridColumns(3)
  .gap(12)
  .marginBottom(24)

  Text("Image Gallery Grid")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Image(src: "https://picsum.photos/150/150?1")
      .width(100)
      .height(100)
      .cornerRadius(8)
    Image(src: "https://picsum.photos/150/150?2")
      .width(100)
      .height(100)
      .cornerRadius(8)
    Image(src: "https://picsum.photos/150/150?3")
      .width(100)
      .height(100)
      .cornerRadius(8)
    Image(src: "https://picsum.photos/150/150?4")
      .width(100)
      .height(100)
      .cornerRadius(8)
  }
  .gridColumns(2)
  .gap(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
