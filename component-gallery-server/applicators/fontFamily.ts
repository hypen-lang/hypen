/**
 * fontFamily Applicator Example
 * Sets the font family (with Google Fonts support).
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const fontFamilyExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("fontFamily Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("System fonts")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Default (system-ui)")
      .fontSize(16)

    Text("Serif")
      .fontSize(16)
      .fontFamily("serif")

    Text("Sans-serif")
      .fontSize(16)
      .fontFamily("sans-serif")

    Text("Monospace")
      .fontSize(16)
      .fontFamily("monospace")
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Google Fonts (auto-loaded)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Roboto - The quick brown fox")
      .fontSize(16)
      .fontFamily("Roboto")

    Text("Open Sans - The quick brown fox")
      .fontSize(16)
      .fontFamily("Open Sans")

    Text("Lato - The quick brown fox")
      .fontSize(16)
      .fontFamily("Lato")

    Text("Montserrat - The quick brown fox")
      .fontSize(16)
      .fontFamily("Montserrat")

    Text("Poppins - The quick brown fox")
      .fontSize(16)
      .fontFamily("Poppins")

    Text("Playfair Display - The quick brown fox")
      .fontSize(16)
      .fontFamily("Playfair Display")
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Code fonts")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("const greeting = 'Hello World';")
      .fontSize(14)
      .fontFamily("Fira Code")
      .backgroundColor("#1f2937")
      .color("#f9fafb")
      .padding(12)
      .cornerRadius(4)

    Text("function calculate(x, y) { return x + y; }")
      .fontSize(14)
      .fontFamily("JetBrains Mono")
      .backgroundColor("#1f2937")
      .color("#f9fafb")
      .padding(12)
      .cornerRadius(4)
  }
  .gap(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
