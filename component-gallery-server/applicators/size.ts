/**
 * size Applicator Example
 * Sets both width and height together.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const sizeExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("size Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Square sizes (same width and height)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("32")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#3b82f6")
      .size(32)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("32x32")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("48")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#22c55e")
      .size(48)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("48x48")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("64")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#f59e0b")
      .size(64)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("64x64")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("96")
          .color("#fff")
          .fontSize(14)
      }
      .backgroundColor("#8b5cf6")
      .size(96)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
      Text("96x96")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(16)
  .marginBottom(24)

  Text("Circle icons with size")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("+")
        .color("#fff")
        .fontSize(20)
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .size(40)
    .cornerRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("-")
        .color("#fff")
        .fontSize(20)
        .fontWeight("600")
    }
    .backgroundColor("#ef4444")
    .size(40)
    .cornerRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("!")
        .color("#fff")
        .fontSize(20)
        .fontWeight("600")
    }
    .backgroundColor("#f59e0b")
    .size(40)
    .cornerRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("?")
        .color("#fff")
        .fontSize(20)
        .fontWeight("600")
    }
    .backgroundColor("#22c55e")
    .size(40)
    .cornerRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
