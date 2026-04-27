/**
 * fontSize Applicator Example
 * Sets the text size.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const fontSizeExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("fontSize Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Size scale")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("fontSize(10) - Extra Small")
      .fontSize(10)

    Text("fontSize(12) - Small")
      .fontSize(12)

    Text("fontSize(14) - Base")
      .fontSize(14)

    Text("fontSize(16) - Medium")
      .fontSize(16)

    Text("fontSize(18) - Large")
      .fontSize(18)

    Text("fontSize(20) - XL")
      .fontSize(20)

    Text("fontSize(24) - 2XL")
      .fontSize(24)

    Text("fontSize(30) - 3XL")
      .fontSize(30)

    Text("fontSize(36) - 4XL")
      .fontSize(36)

    Text("fontSize(48) - 5XL")
      .fontSize(48)
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("In context")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Heading")
      .fontSize(32)
      .fontWeight("700")

    Text("Subheading")
      .fontSize(20)
      .fontWeight("500")
      .color("#666")

    Text("Body text with regular size.")
      .fontSize(16)
      .lineHeight(1.5)
      .color("#374151")

    Text("Small caption text")
      .fontSize(12)
      .color("#9ca3af")
  }
  .gap(8)
  .padding(20)
  .backgroundColor("#fff")
  .cornerRadius(12)
  .border({width: 1, color: "#e5e7eb"})
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
