/**
 * linearGradient Applicator Example
 * Creates gradient backgrounds.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const linearGradientExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("linearGradient Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Horizontal gradients")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Blue to Purple")
        .color("#fff")
        .fontWeight("500")
    }
    .linearGradient("to right, #3b82f6, #8b5cf6")
    .padding(20)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("center")

    Stack {
      Text("Green to Blue")
        .color("#fff")
        .fontWeight("500")
    }
    .linearGradient("to right, #22c55e, #3b82f6")
    .padding(20)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("center")

    Stack {
      Text("Orange to Pink")
        .color("#fff")
        .fontWeight("500")
    }
    .linearGradient("to right, #f59e0b, #ec4899")
    .padding(20)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Vertical gradients")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Top to Bottom")
        .color("#fff")
        .fontSize(12)
    }
    .linearGradient("to bottom, #ef4444, #7c3aed")
    .padding(20)
    .cornerRadius(8)
    .height(100)
    .weight(1)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Stack {
      Text("Bottom to Top")
        .color("#fff")
        .fontSize(12)
    }
    .linearGradient("to top, #06b6d4, #3b82f6")
    .padding(20)
    .cornerRadius(8)
    .height(100)
    .weight(1)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .gap(8)
  .marginBottom(24)

  Text("Diagonal gradients")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {}
      .linearGradient("to bottom right, #fbbf24, #f97316, #ef4444")
      .size(100)
      .cornerRadius(8)

    Stack {}
      .linearGradient("135deg, #667eea, #764ba2")
      .size(100)
      .cornerRadius(8)

    Stack {}
      .linearGradient("45deg, #f093fb, #f5576c")
      .size(100)
      .cornerRadius(8)
  }
  .gap(12)
  .marginBottom(24)

  Text("Gradient button")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Button {
    Text("Gradient Button")
      .color("#fff")
      .fontWeight("600")
  }
  .linearGradient("to right, #6366f1, #8b5cf6, #a855f7")
  .padding(16)
  .paddingHorizontal(32)
  .cornerRadius(8)
  .shadow({x: 0, y: 4, blur: 14, color: "rgba(139,92,246,0.4)"})
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
