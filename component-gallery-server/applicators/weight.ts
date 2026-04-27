/**
 * weight Applicator Example
 * Controls flex grow behavior (like flex: 1).
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const weightExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("weight Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Equal weights")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("weight(1)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")

    Stack {
      Text("weight(1)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")

    Stack {
      Text("weight(1)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#f59e0b")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Different weights")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("weight(1)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")

    Stack {
      Text("weight(2)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(4)
    .weight(2)
    .horizontalAlignment("center")

    Stack {
      Text("weight(1)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#f59e0b")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Fixed + weighted")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Fixed 100px")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#8b5cf6")
    .padding(16)
    .cornerRadius(4)
    .width(100)
    .horizontalAlignment("center")

    Stack {
      Text("weight(1) - fills remaining")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ef4444")
    .padding(16)
    .cornerRadius(4)
    .weight(1)
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Sidebar layout example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("Sidebar")
        .fontWeight("600")
        .marginBottom(8)
      Text("Nav 1")
        .fontSize(14)
      Text("Nav 2")
        .fontSize(14)
      Text("Nav 3")
        .fontSize(14)
    }
    .backgroundColor("#1f2937")
    .color("#fff")
    .padding(16)
    .cornerRadius(8)
    .gap(4)
    .width(150)

    Column {
      Text("Main Content")
        .fontWeight("600")
        .marginBottom(8)
      Text("This area takes all remaining space using weight(1)")
        .fontSize(14)
        .color("#666")
    }
    .backgroundColor("#f9fafb")
    .padding(16)
    .cornerRadius(8)
    .weight(1)
  }
  .gap(12)
  .height(200)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
