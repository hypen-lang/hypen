/**
 * Spinner Component Example
 * Loading indicator.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const spinnerExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Spinner Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Spinner")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Spinner()
    .marginBottom(24)

  Text("Styled Spinners")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Spinner()
        .width(24)
        .height(24)
      Text("Small")
        .fontSize(12)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Spinner()
        .width(40)
        .height(40)
      Text("Medium")
        .fontSize(12)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Spinner()
        .width(56)
        .height(56)
      Text("Large")
        .fontSize(12)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(32)
  .marginBottom(24)

  Text("Loading State Example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Spinner()
        .width(20)
        .height(20)
      Text("Loading content...")
        .color("#666")
        .marginLeft(12)
    }
    .horizontalAlignment("center")
  }
  .padding(24)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .fillMaxWidth(true)
  .horizontalAlignment("center")
  .marginBottom(24)

  Text("Button with Spinner")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Button {
    Row {
      Spinner()
        .width(16)
        .height(16)
      Text("Processing...")
        .color("#fff")
        .marginLeft(8)
    }
    .horizontalAlignment("center")
  }
  .backgroundColor("#3b82f6")
  .padding(12)
  .paddingHorizontal(24)
  .cornerRadius(8)
  .opacity(0.8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
.horizontalAlignment("center")
`
};
