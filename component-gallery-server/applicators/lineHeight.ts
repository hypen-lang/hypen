/**
 * lineHeight Applicator Example
 * Controls spacing between lines of text.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const lineHeightExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("lineHeight Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Line height values")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Text("lineHeight: 1.0")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .fontSize(16)
        .lineHeight(1.0)
    }
    .backgroundColor("#f0f0f0")
    .padding(12)
    .cornerRadius(8)

    Column {
      Text("lineHeight: 1.4")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .fontSize(16)
        .lineHeight(1.4)
    }
    .backgroundColor("#f0f0f0")
    .padding(12)
    .cornerRadius(8)

    Column {
      Text("lineHeight: 1.75 (recommended)")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .fontSize(16)
        .lineHeight(1.75)
    }
    .backgroundColor("#e0e7ff")
    .padding(12)
    .cornerRadius(8)

    Column {
      Text("lineHeight: 2.0")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .fontSize(16)
        .lineHeight(2.0)
    }
    .backgroundColor("#f0f0f0")
    .padding(12)
    .cornerRadius(8)

    Column {
      Text("lineHeight: 2.5 (very loose)")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
        .fontSize(16)
        .lineHeight(2.5)
    }
    .backgroundColor("#f0f0f0")
    .padding(12)
    .cornerRadius(8)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
