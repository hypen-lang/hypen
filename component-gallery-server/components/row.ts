/**
 * Row Component Example
 * A horizontal stack container that arranges children in a row.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const rowExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Row Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Row")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Text("Left")
    Text("Center")
    Text("Right")
  }
  .backgroundColor("#f0f0f0")
  .padding(16)
  .marginBottom(24)

  Text("Styled Row")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("A")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#ef4444")
    .padding(16)
    .cornerRadius(8)

    Column {
      Text("B")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(8)

    Column {
      Text("C")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
  }
  .gap(12)
  .horizontalAlignment("spaceBetween")
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
