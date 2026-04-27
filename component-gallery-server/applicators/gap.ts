/**
 * gap Applicator Example
 * Adds spacing between flex/grid children.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const gapExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("gap Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Gap in Row")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("gap(0)")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#3b82f6").padding(12).cornerRadius(4)
    }
    .gap(0)

    Text("gap(8)")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#22c55e").padding(12).cornerRadius(4)
    }
    .gap(8)

    Text("gap(16)")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#f59e0b").padding(12).cornerRadius(4)
    }
    .gap(16)

    Text("gap(32)")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    Row {
      Stack { Text("A").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
      Stack { Text("B").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
      Stack { Text("C").color("#fff") }.backgroundColor("#8b5cf6").padding(12).cornerRadius(4)
    }
    .gap(32)
  }
  .marginBottom(24)

  Text("Gap in Column")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("gap(4)")
        .fontSize(10)
        .color("#666")
      Stack { Text("1").color("#fff").fontSize(10) }.backgroundColor("#ef4444").padding(8).cornerRadius(4)
      Stack { Text("2").color("#fff").fontSize(10) }.backgroundColor("#ef4444").padding(8).cornerRadius(4)
      Stack { Text("3").color("#fff").fontSize(10) }.backgroundColor("#ef4444").padding(8).cornerRadius(4)
    }
    .gap(4)

    Column {
      Text("gap(12)")
        .fontSize(10)
        .color("#666")
      Stack { Text("1").color("#fff").fontSize(10) }.backgroundColor("#ec4899").padding(8).cornerRadius(4)
      Stack { Text("2").color("#fff").fontSize(10) }.backgroundColor("#ec4899").padding(8).cornerRadius(4)
      Stack { Text("3").color("#fff").fontSize(10) }.backgroundColor("#ec4899").padding(8).cornerRadius(4)
    }
    .gap(12)

    Column {
      Text("gap(24)")
        .fontSize(10)
        .color("#666")
      Stack { Text("1").color("#fff").fontSize(10) }.backgroundColor("#14b8a6").padding(8).cornerRadius(4)
      Stack { Text("2").color("#fff").fontSize(10) }.backgroundColor("#14b8a6").padding(8).cornerRadius(4)
      Stack { Text("3").color("#fff").fontSize(10) }.backgroundColor("#14b8a6").padding(8).cornerRadius(4)
    }
    .gap(24)
  }
  .gap(32)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
