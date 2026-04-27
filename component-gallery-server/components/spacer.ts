/**
 * Spacer Component Example
 * Flexible space that expands to fill available room.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const spacerExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Spacer Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Spacer in Row")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Text("Left")
      .padding(12)
      .backgroundColor("#3b82f6")
      .color("#fff")
      .cornerRadius(8)
    Spacer()
    Text("Right")
      .padding(12)
      .backgroundColor("#22c55e")
      .color("#fff")
      .cornerRadius(8)
  }
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Spacer in Column")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Top")
      .padding(12)
      .backgroundColor("#f59e0b")
      .color("#fff")
      .cornerRadius(8)
    Spacer()
    Text("Bottom")
      .padding(12)
      .backgroundColor("#8b5cf6")
      .color("#fff")
      .cornerRadius(8)
  }
  .height(200)
  .fillMaxWidth(true)
  .backgroundColor("#f0f0f0")
  .padding(16)
  .cornerRadius(8)
  .marginBottom(24)

  Text("Multiple Spacers")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Text("A")
      .padding(12)
      .backgroundColor("#ef4444")
      .color("#fff")
      .cornerRadius(8)
    Spacer()
    Text("B")
      .padding(12)
      .backgroundColor("#22c55e")
      .color("#fff")
      .cornerRadius(8)
    Spacer()
    Text("C")
      .padding(12)
      .backgroundColor("#3b82f6")
      .color("#fff")
      .cornerRadius(8)
  }
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
