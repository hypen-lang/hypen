/**
 * transform Applicator Example
 * CSS transform property.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const transformExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("transform Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Various transforms")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("None")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#3b82f6")
      .padding(16)
      .cornerRadius(8)
      Text("Original")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Rotate")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#22c55e")
      .padding(16)
      .cornerRadius(8)
      .transform("rotate(15deg)")
      Text("rotate(15deg)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Scale")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#f59e0b")
      .padding(16)
      .cornerRadius(8)
      .transform("scale(1.2)")
      Text("scale(1.2)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Skew")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#8b5cf6")
      .padding(16)
      .cornerRadius(8)
      .transform("skewX(-10deg)")
      Text("skewX(-10deg)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(24)
  .marginBottom(32)

  Text("Translate")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("Up")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#ef4444")
      .padding(16)
      .cornerRadius(8)
      .transform("translateY(-10px)")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Down")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#ec4899")
      .padding(16)
      .cornerRadius(8)
      .transform("translateY(10px)")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Left")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#14b8a6")
      .padding(16)
      .cornerRadius(8)
      .transform("translateX(-10px)")
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Right")
          .color("#fff")
          .fontSize(12)
      }
      .backgroundColor("#6366f1")
      .padding(16)
      .cornerRadius(8)
      .transform("translateX(10px)")
    }
    .horizontalAlignment("center")
  }
  .gap(24)
  .marginBottom(32)

  Text("Combined transforms")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Text("Rotate + Scale")
      .color("#fff")
      .fontWeight("600")
  }
  .backgroundColor("#3b82f6")
  .padding(24)
  .cornerRadius(12)
  .transform("rotate(-5deg) scale(1.1)")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
.horizontalAlignment("center")
`
};
