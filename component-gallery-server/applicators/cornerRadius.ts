/**
 * cornerRadius Applicator Example
 * Alias for borderRadius (Compose naming convention).
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const cornerRadiusExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("cornerRadius Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Same as borderRadius (Compose naming)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("4")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .size(64)
      .cornerRadius(4)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("12")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .size(64)
      .cornerRadius(12)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("24")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .size(64)
      .cornerRadius(24)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("32")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .size(64)
      .cornerRadius(32)
      .horizontalAlignment("center")
      .verticalAlignment("center")
    }
    .horizontalAlignment("center")
  }
  .gap(12)
  .marginBottom(24)

  Text("Cards with cornerRadius")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Column {
        Text("Card Title")
          .fontWeight("600")
        Text("With cornerRadius(8)")
          .fontSize(14)
          .color("#666")
      }
      .gap(4)
    }
    .backgroundColor("#fff")
    .padding(16)
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .fillMaxWidth(true)

    Stack {
      Column {
        Text("Card Title")
          .fontWeight("600")
        Text("With cornerRadius(16)")
          .fontSize(14)
          .color("#666")
      }
      .gap(4)
    }
    .backgroundColor("#fff")
    .padding(16)
    .cornerRadius(16)
    .border({width: 1, color: "#e5e7eb"})
    .fillMaxWidth(true)

    Stack {
      Column {
        Text("Card Title")
          .fontWeight("600")
        Text("With cornerRadius(24)")
          .fontSize(14)
          .color("#666")
      }
      .gap(4)
    }
    .backgroundColor("#fff")
    .padding(16)
    .cornerRadius(24)
    .border({width: 1, color: "#e5e7eb"})
    .fillMaxWidth(true)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#f9fafb")
`
};
