/**
 * Column Component Example
 * A vertical stack container that arranges children in a column.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const columnExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Column Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Column")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Item 1")
    Text("Item 2")
    Text("Item 3")
  }
  .backgroundColor("#f0f0f0")
  .padding(16)
  .marginBottom(24)

  Text("Styled Column")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Item A")
      .color("#fff")
    Text("Item B")
      .color("#fff")
    Text("Item C")
      .color("#fff")
  }
  .backgroundColor("#3b82f6")
  .padding(20)
  .gap(12)
  .cornerRadius(12)
  .horizontalAlignment("center")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
