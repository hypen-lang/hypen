/**
 * opacity Applicator Example
 * Controls the transparency of an element.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const opacityExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("opacity Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Opacity values")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("1.0")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .opacity(1.0)

    Stack {
      Text("0.8")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .opacity(0.8)

    Stack {
      Text("0.6")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .opacity(0.6)

    Stack {
      Text("0.4")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .opacity(0.4)

    Stack {
      Text("0.2")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .opacity(0.2)
  }
  .gap(8)
  .marginBottom(24)

  Text("Opacity with images")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Image(src: "https://picsum.photos/100/100?1")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .opacity(1.0)
      Text("1.0")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "https://picsum.photos/100/100?1")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .opacity(0.7)
      Text("0.7")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Image(src: "https://picsum.photos/100/100?1")
        .width(80)
        .height(80)
        .cornerRadius(8)
        .opacity(0.4)
      Text("0.4")
        .fontSize(12)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(16)
  .marginBottom(24)

  Text("Disabled state example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Button {
      Text("Enabled")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .paddingHorizontal(24)
    .cornerRadius(8)

    Button {
      Text("Disabled")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .paddingHorizontal(24)
    .cornerRadius(8)
    .opacity(0.5)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
