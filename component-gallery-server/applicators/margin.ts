/**
 * margin Applicator Example
 * Adds external spacing around elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const marginExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("margin Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Without margin")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("A")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(16)

    Stack {
      Text("B")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(16)

    Stack {
      Text("C")
        .color("#fff")
    }
    .backgroundColor("#f59e0b")
    .padding(16)
  }
  .backgroundColor("#f0f0f0")
  .padding(8)
  .cornerRadius(8)
  .marginBottom(24)

  Text("With margin")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("A")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .margin(8)

    Stack {
      Text("B")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .margin(8)

    Stack {
      Text("C")
        .color("#fff")
    }
    .backgroundColor("#f59e0b")
    .padding(16)
    .margin(8)
  }
  .backgroundColor("#f0f0f0")
  .padding(8)
  .cornerRadius(8)
  .marginBottom(24)

  Text("Directional margins")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("marginLeft(32)")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .marginLeft(32)

    Stack {
      Text("marginTop(24)")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(12)
    .marginTop(24)

    Stack {
      Text("marginHorizontal(48)")
        .color("#fff")
    }
    .backgroundColor("#8b5cf6")
    .padding(12)
    .marginHorizontal(48)
  }
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
