/**
 * Text Component Example
 * Displays text content with various styling options.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const textExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Text Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Text")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Text("Hello, World!")
    .marginBottom(24)

  Text("Styled Text Variations")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Large Bold Text")
      .fontSize(28)
      .fontWeight("700")
      .color("#1a1a1a")

    Text("Medium Regular Text")
      .fontSize(18)
      .fontWeight("400")
      .color("#333")

    Text("Small Light Text")
      .fontSize(12)
      .fontWeight("300")
      .color("#666")

    Text("Colored Text")
      .fontSize(16)
      .color("#3b82f6")

    Text("Italic Text")
      .fontSize(16)
      .fontStyle("italic")
      .color("#333")

    Text("Underlined Text")
      .fontSize(16)
      .textDecoration("underline")
      .color("#333")

    Text("UPPERCASE TEXT")
      .fontSize(14)
      .textTransform("uppercase")
      .letterSpacing(2)
      .color("#666")
  }
  .gap(12)
  .backgroundColor("#f9fafb")
  .padding(20)
  .cornerRadius(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
