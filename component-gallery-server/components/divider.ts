/**
 * Divider Component Example
 * Visual separator line.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const dividerExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Divider Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Divider")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Content above")
    Divider()
    Text("Content below")
  }
  .gap(12)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Styled Dividers")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Default Divider")
    Divider()
      .backgroundColor("#e5e7eb")

    Text("Thick Divider")
    Divider()
      .height(3)
      .backgroundColor("#3b82f6")

    Text("Dashed Style (using border)")
    Column {}
      .height(1)
      .fillMaxWidth(true)
      .border({width: 1, style: "dashed", color: "#9ca3af"})

    Text("Gradient Divider")
    Column {}
      .height(2)
      .fillMaxWidth(true)
      .linearGradient("to right, #3b82f6, #8b5cf6, #ec4899")
      .cornerRadius(1)
  }
  .gap(16)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Divider in List")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Text("Item 1")
        .fontWeight("500")
      Spacer()
      Text(">")
        .color("#9ca3af")
    }
    .padding(12)

    Divider()
      .backgroundColor("#e5e7eb")
      .marginLeft(12)

    Row {
      Text("Item 2")
        .fontWeight("500")
      Spacer()
      Text(">")
        .color("#9ca3af")
    }
    .padding(12)

    Divider()
      .backgroundColor("#e5e7eb")
      .marginLeft(12)

    Row {
      Text("Item 3")
        .fontWeight("500")
      Spacer()
      Text(">")
        .color("#9ca3af")
    }
    .padding(12)
  }
  .backgroundColor("#fff")
  .cornerRadius(8)
  .border({width: 1, color: "#e5e7eb"})
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
