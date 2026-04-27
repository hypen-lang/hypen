/**
 * flex Applicator Example
 * CSS flex shorthand property.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const flexExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("flex Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("flex values")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("flex(1) - grow equally")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    Row {
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#3b82f6").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#22c55e").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#f59e0b").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
    }
    .gap(8)

    Text("flex(2) middle")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#8b5cf6").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
      Stack { Text("flex(2)").color("#fff").fontSize(10) }
        .backgroundColor("#ec4899").padding(12).cornerRadius(4).flex(2).horizontalAlignment("center")
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#14b8a6").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
    }
    .gap(8)

    Text("flex(0) - don't grow")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("flex(0)").color("#fff").fontSize(10) }
        .backgroundColor("#ef4444").padding(12).cornerRadius(4).flex(0).horizontalAlignment("center")
      Stack { Text("flex(1)").color("#fff").fontSize(10) }
        .backgroundColor("#6366f1").padding(12).cornerRadius(4).flex(1).horizontalAlignment("center")
    }
    .gap(8)
  }
  .marginBottom(24)

  Text("flexGrow and flexShrink")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("flexGrow(1)")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    Row {
      Stack { Text("No grow").fontSize(10) }
        .backgroundColor("#f0f0f0").padding(12).cornerRadius(4)
      Stack { Text("flexGrow(1)").color("#fff").fontSize(10) }
        .backgroundColor("#3b82f6").padding(12).cornerRadius(4).flexGrow(1).horizontalAlignment("center")
    }
    .gap(8)

    Text("flexShrink behavior")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("Can shrink").fontSize(10) }
        .backgroundColor("#22c55e").color("#fff").padding(12).cornerRadius(4).width(200).flexShrink(1)
      Stack { Text("Won't shrink").fontSize(10) }
        .backgroundColor("#f59e0b").color("#fff").padding(12).cornerRadius(4).width(200).flexShrink(0)
    }
    .gap(8)
    .maxWidth(300)
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
