/**
 * color Applicator Example
 * Sets the text color.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const colorExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("color Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Default color")
    .fontSize(14)
    .marginBottom(8)

  Stack {
    Text("Default text color")
  }
  .padding(16)
  .backgroundColor("#f0f0f0")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Named colors")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("color: red")
      .color("red")
      .fontSize(16)

    Text("color: blue")
      .color("blue")
      .fontSize(16)

    Text("color: green")
      .color("green")
      .fontSize(16)

    Text("color: orange")
      .color("orange")
      .fontSize(16)

    Text("color: purple")
      .color("purple")
      .fontSize(16)
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Hex colors")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("#3b82f6 - Blue")
      .color("#3b82f6")
      .fontSize(16)

    Text("#22c55e - Green")
      .color("#22c55e")
      .fontSize(16)

    Text("#ef4444 - Red")
      .color("#ef4444")
      .fontSize(16)

    Text("#f59e0b - Amber")
      .color("#f59e0b")
      .fontSize(16)

    Text("#8b5cf6 - Violet")
      .color("#8b5cf6")
      .fontSize(16)

    Text("#ec4899 - Pink")
      .color("#ec4899")
      .fontSize(16)
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("RGBA colors")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("rgba(0, 0, 0, 1.0)")
        .color("rgba(0, 0, 0, 1.0)")
      Text("rgba(0, 0, 0, 0.7)")
        .color("rgba(0, 0, 0, 0.7)")
      Text("rgba(0, 0, 0, 0.5)")
        .color("rgba(0, 0, 0, 0.5)")
      Text("rgba(0, 0, 0, 0.3)")
        .color("rgba(0, 0, 0, 0.3)")
    }
    .gap(4)
  }
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
