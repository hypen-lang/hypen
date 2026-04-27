/**
 * padding Applicator Example
 * Adds internal spacing around content.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const paddingExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("padding Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Without padding")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Text("No padding")
      .backgroundColor("#3b82f6")
      .color("#fff")
  }
  .backgroundColor("#e0e7ff")
  .marginBottom(24)

  Text("With padding (various values)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("padding(8)")
        .backgroundColor("#3b82f6")
        .color("#fff")
    }
    .backgroundColor("#e0e7ff")
    .padding(8)

    Stack {
      Text("padding(16)")
        .backgroundColor("#22c55e")
        .color("#fff")
    }
    .backgroundColor("#dcfce7")
    .padding(16)

    Stack {
      Text("padding(24)")
        .backgroundColor("#f59e0b")
        .color("#fff")
    }
    .backgroundColor("#fef3c7")
    .padding(24)

    Stack {
      Text("padding(32)")
        .backgroundColor("#8b5cf6")
        .color("#fff")
    }
    .backgroundColor("#ede9fe")
    .padding(32)
  }
  .gap(16)
  .marginBottom(24)

  Text("Directional padding")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("paddingHorizontal(32)")
        .backgroundColor("#3b82f6")
        .color("#fff")
    }
    .backgroundColor("#e0e7ff")
    .paddingHorizontal(32)
    .paddingVertical(8)

    Stack {
      Text("paddingVertical(32)")
        .backgroundColor("#22c55e")
        .color("#fff")
    }
    .backgroundColor("#dcfce7")
    .paddingVertical(32)
    .paddingHorizontal(8)

    Stack {
      Text("paddingLeft(48)")
        .backgroundColor("#ef4444")
        .color("#fff")
    }
    .backgroundColor("#fee2e2")
    .paddingLeft(48)
    .padding(8)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
