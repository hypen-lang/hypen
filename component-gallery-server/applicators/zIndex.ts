/**
 * zIndex Applicator Example
 * Controls stacking order of elements within a Stack.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const zIndexExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("zIndex Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Stack children are layered in order")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("First (bottom)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(24)
    .cornerRadius(8)

    Column {
      Text("Second (middle)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(24)
    .cornerRadius(8)
    .marginLeft(40)
    .marginTop(30)

    Column {
      Text("Third (top)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#f59e0b")
    .padding(24)
    .cornerRadius(8)
    .marginLeft(80)
    .marginTop(60)
  }
  .marginBottom(24)

  Text("Using zIndex to reorder")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("First but z:3 (top)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ef4444")
    .padding(24)
    .cornerRadius(8)
    .zIndex(3)

    Column {
      Text("Second z:1 (bottom)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ec4899")
    .padding(24)
    .cornerRadius(8)
    .marginLeft(40)
    .marginTop(30)
    .zIndex(1)

    Column {
      Text("Third z:2 (middle)")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#8b5cf6")
    .padding(24)
    .cornerRadius(8)
    .marginLeft(80)
    .marginTop(60)
    .zIndex(2)
  }
  .marginBottom(24)

  Text("Modal overlay example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("Background content")
        .color("#666")
    }
    .backgroundColor("#fff")
    .padding(16)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .zIndex(1)

    Column {
      Text("Modal")
        .fontWeight("600")
        .marginBottom(8)
      Text("This has high zIndex")
        .fontSize(14)
        .color("#666")
    }
    .backgroundColor("#fff")
    .padding(20)
    .cornerRadius(12)
    .shadow({x: 0, y: 10, blur: 25, color: "rgba(0,0,0,0.2)"})
    .marginTop(20)
    .marginLeft(20)
    .zIndex(100)
  }
  .height(150)
  .fillMaxWidth(true)
  .backgroundColor("rgba(0,0,0,0.3)")
  .cornerRadius(8)
  .padding(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
