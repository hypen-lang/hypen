/**
 * rotate Applicator Example
 * Rotates elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const rotateExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("rotate Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Rotation angles")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("0")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#3b82f6")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("0deg")
      Text("0deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("15")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#22c55e")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("15deg")
      Text("15deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("45")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#f59e0b")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("45deg")
      Text("45deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("90")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#8b5cf6")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("90deg")
      Text("90deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("180")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#ef4444")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("180deg")
      Text("180deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(24)
  .marginBottom(32)

  Text("Negative rotation")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("-15")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#ec4899")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("-15deg")
      Text("-15deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("-45")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#14b8a6")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("-45deg")
      Text("-45deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("-90")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#6366f1")
      .size(60)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .rotate("-90deg")
      Text("-90deg")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(24)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
.horizontalAlignment("center")
`
};
