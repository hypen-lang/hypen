/**
 * fontWeight Applicator Example
 * Sets the text weight/boldness.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const fontWeightExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("fontWeight Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Weight scale")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("fontWeight(100) - Thin")
      .fontSize(18)
      .fontWeight("100")

    Text("fontWeight(200) - Extra Light")
      .fontSize(18)
      .fontWeight("200")

    Text("fontWeight(300) - Light")
      .fontSize(18)
      .fontWeight("300")

    Text("fontWeight(400) - Normal")
      .fontSize(18)
      .fontWeight("400")

    Text("fontWeight(500) - Medium")
      .fontSize(18)
      .fontWeight("500")

    Text("fontWeight(600) - Semi Bold")
      .fontSize(18)
      .fontWeight("600")

    Text("fontWeight(700) - Bold")
      .fontSize(18)
      .fontWeight("700")

    Text("fontWeight(800) - Extra Bold")
      .fontSize(18)
      .fontWeight("800")

    Text("fontWeight(900) - Black")
      .fontSize(18)
      .fontWeight("900")
  }
  .gap(6)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("In context")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Bold Heading")
      .fontSize(24)
      .fontWeight("700")

    Text("Medium subheading")
      .fontSize(18)
      .fontWeight("500")

    Text("Regular body text for comfortable reading.")
      .fontSize(16)
      .fontWeight("400")

    Text("Light caption")
      .fontSize(14)
      .fontWeight("300")
      .color("#666")
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
