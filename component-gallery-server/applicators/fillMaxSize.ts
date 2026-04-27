/**
 * fillMaxSize Applicator Example
 * Makes element fill all available space.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const fillMaxSizeExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("fillMaxSize Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("fillMaxWidth")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Default width")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .cornerRadius(4)

    Stack {
      Text("fillMaxWidth(true)")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(12)
    .cornerRadius(4)
    .fillMaxWidth(true)
  }
  .gap(8)
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
  .marginBottom(24)

  Text("fillMaxHeight")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Default")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#f59e0b")
    .padding(12)
    .cornerRadius(4)

    Stack {
      Text("fillMaxHeight")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#8b5cf6")
    .padding(12)
    .cornerRadius(4)
    .fillMaxHeight(true)
  }
  .gap(8)
  .height(150)
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
  .marginBottom(24)

  Text("fillMaxSize (both)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Stack {
      Text("fillMaxSize(true)")
        .color("#fff")
        .fontSize(16)
    }
    .backgroundColor("#ec4899")
    .cornerRadius(8)
    .fillMaxSize(true)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .height(150)
  .fillMaxWidth(true)
  .backgroundColor("#f0f0f0")
  .padding(8)
  .cornerRadius(8)
  .marginBottom(24)

  Text("Fractional fill")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("0.5")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .fillMaxWidth(0.5)
    .padding(12)
    .cornerRadius(4)

    Stack {
      Text("0.5")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .fillMaxWidth(0.5)
    .padding(12)
    .cornerRadius(4)
  }
  .gap(8)
  .backgroundColor("#f0f0f0")
  .padding(8)
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
