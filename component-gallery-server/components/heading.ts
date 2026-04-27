/**
 * Heading Component Example
 * Semantic heading with built-in sizing.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const headingExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Heading Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Headings")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Heading(level: 1) { Text("Heading 1") }
    Heading(level: 2) { Text("Heading 2") }
    Heading(level: 3) { Text("Heading 3") }
    Heading(level: 4) { Text("Heading 4") }
    Heading(level: 5) { Text("Heading 5") }
    Heading(level: 6) { Text("Heading 6") }
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Styled Headings")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Heading(level: 1) {
      Text("Welcome to Hypen")
    }
    .color("#1a1a1a")

    Heading(level: 2) {
      Text("Build Cross-Platform UIs")
    }
    .color("#3b82f6")

    Heading(level: 3) {
      Text("Simple and Declarative")
    }
    .color("#22c55e")
    .fontWeight("500")

    Column {
      Heading(level: 2) {
        Text("Article Title")
      }
      .marginBottom(8)

      Text("Published on January 27, 2026")
        .fontSize(14)
        .color("#666")
        .marginBottom(16)

      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .lineHeight(1.6)
        .color("#374151")
    }
    .padding(20)
    .backgroundColor("#fff")
    .cornerRadius(12)
    .border({width: 1, color: "#e5e7eb"})
    .marginTop(16)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
