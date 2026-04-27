/**
 * verticalAlignment Applicator Example
 * Controls alignment along the vertical axis (main axis for Column, cross axis for Row).
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const verticalAlignmentExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("verticalAlignment Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Row with horizontalAlignment")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("flex-start")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("start")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)

    Text("center")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("center")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)

    Text("flex-end")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("end")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
    .gap(8)

    Text("space-between")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("spaceBetween")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)

    Text("space-around")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#ef4444").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#ef4444").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#ef4444").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("spaceAround")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)

    Text("space-evenly")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#ec4899").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#ec4899").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#ec4899").padding(12).cornerRadius(4)
    }
    .horizontalAlignment("spaceEvenly")
    .backgroundColor("#f0f0f0")
    .padding(8)
    .cornerRadius(4)
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
