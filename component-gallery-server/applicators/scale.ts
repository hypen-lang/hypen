/**
 * scale Applicator Example
 * Scales elements up or down.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const scaleExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("scale Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Scale values")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("0.5")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .padding(16)
      .cornerRadius(8)
      .scale(0.5)
      Text("scale(0.5)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
    .width(80)

    Column {
      Stack {
        Text("0.75")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .padding(16)
      .cornerRadius(8)
      .scale(0.75)
      Text("scale(0.75)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
    .width(80)

    Column {
      Stack {
        Text("1.0")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#f59e0b")
      .padding(16)
      .cornerRadius(8)
      .scale(1.0)
      Text("scale(1.0)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
    .width(80)

    Column {
      Stack {
        Text("1.25")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#8b5cf6")
      .padding(16)
      .cornerRadius(8)
      .scale(1.25)
      Text("scale(1.25)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
    .width(100)

    Column {
      Stack {
        Text("1.5")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#ef4444")
      .padding(16)
      .cornerRadius(8)
      .scale(1.5)
      Text("scale(1.5)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
    .width(120)
  }
  .gap(16)
  .marginBottom(32)

  Text("Directional scale")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("X")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#ec4899")
      .padding(16)
      .cornerRadius(8)
      .scaleX(1.5)
      Text("scaleX(1.5)")
        .fontSize(10)
        .color("#666")
        .marginTop(12)
    }
    .horizontalAlignment("center")
    .width(100)

    Column {
      Stack {
        Text("Y")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#14b8a6")
      .padding(16)
      .cornerRadius(8)
      .scaleY(1.5)
      Text("scaleY(1.5)")
        .fontSize(10)
        .color("#666")
        .marginTop(12)
    }
    .horizontalAlignment("center")
    .width(100)
  }
  .gap(32)
  .marginBottom(32)

  Text("Hover-like effect (scale for buttons)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Button {
      Text("Normal")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .paddingHorizontal(24)
    .cornerRadius(8)

    Button {
      Text("Scaled Up")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .paddingHorizontal(24)
    .cornerRadius(8)
    .scale(1.05)
  }
  .gap(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
.horizontalAlignment("center")
`
};
