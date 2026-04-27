/**
 * height Applicator Example
 * Sets the height of an element.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const heightExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("height Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Fixed heights")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("50")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#3b82f6")
      .width(60)
      .height(50)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }

    Column {
      Stack {
        Text("100")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#22c55e")
      .width(60)
      .height(100)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }

    Column {
      Stack {
        Text("150")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#f59e0b")
      .width(60)
      .height(150)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }

    Column {
      Stack {
        Text("200")
          .color("#fff")
          .fontSize(10)
      }
      .backgroundColor("#8b5cf6")
      .width(60)
      .height(200)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }
  }
  .gap(12)
  .horizontalAlignment("end")
  .marginBottom(24)

  Text("Percentage heights")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("25%")
        .color("#fff")
        .fontSize(10)
    }
    .backgroundColor("#ef4444")
    .width(50)
    .height("25%")
    .cornerRadius(4)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("50%")
        .color("#fff")
        .fontSize(10)
    }
    .backgroundColor("#ec4899")
    .width(50)
    .height("50%")
    .cornerRadius(4)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("75%")
        .color("#fff")
        .fontSize(10)
    }
    .backgroundColor("#14b8a6")
    .width(50)
    .height("75%")
    .cornerRadius(4)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("100%")
        .color("#fff")
        .fontSize(10)
    }
    .backgroundColor("#6366f1")
    .width(50)
    .height("100%")
    .cornerRadius(4)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .gap(8)
  .height(200)
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
  .horizontalAlignment("end")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
