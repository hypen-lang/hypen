/**
 * width Applicator Example
 * Sets the width of an element.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const widthExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("width Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Fixed widths")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("width(100)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(8)
    .cornerRadius(4)
    .width(100)

    Stack {
      Text("width(200)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(8)
    .cornerRadius(4)
    .width(200)

    Stack {
      Text("width(300)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#f59e0b")
    .padding(8)
    .cornerRadius(4)
    .width(300)
  }
  .gap(8)
  .marginBottom(24)

  Text("Percentage widths")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("25%")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#8b5cf6")
    .padding(8)
    .cornerRadius(4)
    .width("25%")

    Stack {
      Text("50%")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ec4899")
    .padding(8)
    .cornerRadius(4)
    .width("50%")

    Stack {
      Text("75%")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#14b8a6")
    .padding(8)
    .cornerRadius(4)
    .width("75%")

    Stack {
      Text("100%")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ef4444")
    .padding(8)
    .cornerRadius(4)
    .width("100%")
  }
  .gap(8)
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
  .marginBottom(24)

  Text("Min/Max widths")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("minWidth(200)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(8)
    .cornerRadius(4)
    .minWidth(200)

    Stack {
      Text("maxWidth(150) with long text that exceeds")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(8)
    .cornerRadius(4)
    .maxWidth(150)
  }
  .gap(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
