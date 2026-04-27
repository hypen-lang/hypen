/**
 * gridColumns Applicator Example
 * Sets the number of grid columns.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const gridColumnsExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("gridColumns Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("2 columns")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Stack { Text("1").color("#fff") }.backgroundColor("#3b82f6").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("2").color("#fff") }.backgroundColor("#3b82f6").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("3").color("#fff") }.backgroundColor("#3b82f6").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("4").color("#fff") }.backgroundColor("#3b82f6").padding(16).cornerRadius(4).horizontalAlignment("center")
  }
  .gridColumns(2)
  .gap(8)
  .marginBottom(24)

  Text("3 columns")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Stack { Text("1").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("2").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("3").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("4").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("5").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("6").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4).horizontalAlignment("center")
  }
  .gridColumns(3)
  .gap(8)
  .marginBottom(24)

  Text("4 columns")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Stack { Text("1").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("2").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("3").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("4").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("5").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("6").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("7").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
    Stack { Text("8").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4).horizontalAlignment("center")
  }
  .gridColumns(4)
  .gap(8)
  .marginBottom(24)

  Text("Image gallery (3 columns)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Grid {
    Image(src: "https://picsum.photos/100/100?1").cornerRadius(8)
    Image(src: "https://picsum.photos/100/100?2").cornerRadius(8)
    Image(src: "https://picsum.photos/100/100?3").cornerRadius(8)
    Image(src: "https://picsum.photos/100/100?4").cornerRadius(8)
    Image(src: "https://picsum.photos/100/100?5").cornerRadius(8)
    Image(src: "https://picsum.photos/100/100?6").cornerRadius(8)
  }
  .gridColumns(3)
  .gap(4)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
