/**
 * textAlign Applicator Example
 * Controls text alignment.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const textAlignExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("textAlign Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Alignment options")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("textAlign: left")
        .textAlign("left")
    }
    .backgroundColor("#e0e7ff")
    .padding(16)
    .cornerRadius(4)
    .fillMaxWidth(true)

    Stack {
      Text("textAlign: center")
        .textAlign("center")
    }
    .backgroundColor("#dcfce7")
    .padding(16)
    .cornerRadius(4)
    .fillMaxWidth(true)

    Stack {
      Text("textAlign: right")
        .textAlign("right")
    }
    .backgroundColor("#fef3c7")
    .padding(16)
    .cornerRadius(4)
    .fillMaxWidth(true)

    Stack {
      Text("textAlign: justify - Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor.")
        .textAlign("justify")
    }
    .backgroundColor("#fee2e2")
    .padding(16)
    .cornerRadius(4)
    .fillMaxWidth(true)
  }
  .gap(8)
  .marginBottom(24)

  Text("In cards")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("Left Aligned")
        .fontWeight("600")
        .marginBottom(4)
      Text("Default text alignment")
        .fontSize(14)
        .color("#666")
    }
    .padding(16)
    .backgroundColor("#fff")
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .textAlign("left")
    .weight(1)

    Column {
      Text("Centered")
        .fontWeight("600")
        .marginBottom(4)
      Text("Good for headers")
        .fontSize(14)
        .color("#666")
    }
    .padding(16)
    .backgroundColor("#fff")
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .textAlign("center")
    .weight(1)

    Column {
      Text("Right Aligned")
        .fontWeight("600")
        .marginBottom(4)
      Text("For special cases")
        .fontSize(14)
        .color("#666")
    }
    .padding(16)
    .backgroundColor("#fff")
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})
    .textAlign("right")
    .weight(1)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#f9fafb")
`
};
