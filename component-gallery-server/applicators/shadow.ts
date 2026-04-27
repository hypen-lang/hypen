/**
 * shadow Applicator Example
 * Adds box shadow to elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const shadowExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("shadow Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Shadow sizes")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("Small")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .shadow({x: 0, y: 1, blur: 3, color: "rgba(0,0,0,0.1)"})
    }
    .weight(1)
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Medium")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .shadow({x: 0, y: 4, blur: 6, color: "rgba(0,0,0,0.1)"})
    }
    .weight(1)
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("Large")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .shadow({x: 0, y: 10, blur: 15, color: "rgba(0,0,0,0.1)"})
    }
    .weight(1)
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("XL")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .shadow({x: 0, y: 20, blur: 25, color: "rgba(0,0,0,0.15)"})
    }
    .weight(1)
    .horizontalAlignment("center")
  }
  .gap(16)
  .padding(24)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Colored shadows")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Blue")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .shadow({x: 0, y: 4, blur: 14, color: "rgba(59,130,246,0.5)"})

    Stack {
      Text("Green")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(8)
    .shadow({x: 0, y: 4, blur: 14, color: "rgba(34,197,94,0.5)"})

    Stack {
      Text("Purple")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#8b5cf6")
    .padding(16)
    .cornerRadius(8)
    .shadow({x: 0, y: 4, blur: 14, color: "rgba(139,92,246,0.5)"})

    Stack {
      Text("Pink")
        .color("#fff")
        .fontSize(12)
    }
    .backgroundColor("#ec4899")
    .padding(16)
    .cornerRadius(8)
    .shadow({x: 0, y: 4, blur: 14, color: "rgba(236,72,153,0.5)"})
  }
  .gap(16)
  .marginBottom(24)

  Text("Shadow card example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("Card with Shadow")
        .fontSize(18)
        .fontWeight("600")
        .marginBottom(8)
      Text("Shadows add depth and hierarchy to your interface.")
        .fontSize(14)
        .color("#666")
        .lineHeight(1.5)
    }
  }
  .backgroundColor("#fff")
  .padding(24)
  .cornerRadius(16)
  .shadow({x: 0, y: 4, blur: 20, color: "rgba(0,0,0,0.08)"})
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#f9fafb")
`
};
