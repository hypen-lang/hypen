/**
 * horizontalAlignment Applicator Example
 * Controls alignment along the horizontal axis (cross axis for Column, main axis for Row).
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const horizontalAlignmentExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("horizontalAlignment Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Row with verticalAlignment")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("flex-start")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#3b82f6").padding(8).cornerRadius(4)
      Stack { Text("BB").color("#fff") }.backgroundColor("#3b82f6").padding(16).cornerRadius(4)
      Stack { Text("CCC").color("#fff") }.backgroundColor("#3b82f6").padding(24).cornerRadius(4)
    }
    .verticalAlignment("flex-start")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)
    .height(100)

    Text("center")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#22c55e").padding(8).cornerRadius(4)
      Stack { Text("BB").color("#fff") }.backgroundColor("#22c55e").padding(16).cornerRadius(4)
      Stack { Text("CCC").color("#fff") }.backgroundColor("#22c55e").padding(24).cornerRadius(4)
    }
    .verticalAlignment("center")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)
    .height(100)

    Text("flex-end")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#f59e0b").padding(8).cornerRadius(4)
      Stack { Text("BB").color("#fff") }.backgroundColor("#f59e0b").padding(16).cornerRadius(4)
      Stack { Text("CCC").color("#fff") }.backgroundColor("#f59e0b").padding(24).cornerRadius(4)
    }
    .verticalAlignment("flex-end")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)
    .height(100)

    Text("stretch")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#8b5cf6").padding(8).cornerRadius(4)
      Stack { Text("BB").color("#fff") }.backgroundColor("#8b5cf6").padding(8).cornerRadius(4)
      Stack { Text("CCC").color("#fff") }.backgroundColor("#8b5cf6").padding(8).cornerRadius(4)
    }
    .verticalAlignment("stretch")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)
    .height(100)
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
