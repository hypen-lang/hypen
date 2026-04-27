/**
 * List Component Example
 * A scrollable list of items.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const listExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("List Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw List")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  List {
    Text("Item 1")
    Text("Item 2")
    Text("Item 3")
  }
  .backgroundColor("#f0f0f0")
  .padding(16)
  .marginBottom(24)

  Text("Styled List")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  List {
    Row {
      Column {
        Text("A")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#3b82f6")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .horizontalAlignment("center")
      .verticalAlignment("center")

      Column {
        Text("First Item")
          .fontWeight("500")
        Text("Description for item 1")
          .fontSize(12)
          .color("#666")
      }
      .gap(2)
    }
    .gap(12)
    .padding(12)
    .backgroundColor("#fff")
    .horizontalAlignment("center")

    Row {
      Column {
        Text("B")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#22c55e")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .horizontalAlignment("center")
      .verticalAlignment("center")

      Column {
        Text("Second Item")
          .fontWeight("500")
        Text("Description for item 2")
          .fontSize(12)
          .color("#666")
      }
      .gap(2)
    }
    .gap(12)
    .padding(12)
    .backgroundColor("#fff")
    .horizontalAlignment("center")

    Row {
      Column {
        Text("C")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#f59e0b")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .horizontalAlignment("center")
      .verticalAlignment("center")

      Column {
        Text("Third Item")
          .fontWeight("500")
        Text("Description for item 3")
          .fontSize(12)
          .color("#666")
      }
      .gap(2)
    }
    .gap(12)
    .padding(12)
    .backgroundColor("#fff")
    .horizontalAlignment("center")
  }
  .backgroundColor("#f0f0f0")
  .cornerRadius(12)
  .gap(1)
  .overflow("hidden")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
