/**
 * Center Component Example
 * Centers its children both horizontally and vertically.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const centerExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Center Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Center")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Center {
    Text("Centered!")
  }
  .backgroundColor("#f0f0f0")
  .height(100)
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Styled Center")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Center {
    Column {
      Text("Perfectly Centered")
        .fontSize(20)
        .fontWeight("600")
        .color("#fff")
      Text("Both horizontally and vertically")
        .fontSize(14)
        .color("#e0e7ff")
    }
    .horizontalAlignment("center")
    .gap(8)
  }
  .backgroundColor("#6366f1")
  .height(200)
  .fillMaxWidth(true)
  .cornerRadius(12)
  .marginBottom(24)

  Text("Center with Icon-like Content")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Center {
      Text("+")
        .fontSize(32)
        .fontWeight("600")
        .color("#3b82f6")
    }
    .width(64)
    .height(64)
    .backgroundColor("#eff6ff")
    .cornerRadius(32)

    Center {
      Text("!")
        .fontSize(32)
        .fontWeight("600")
        .color("#f59e0b")
    }
    .width(64)
    .height(64)
    .backgroundColor("#fffbeb")
    .cornerRadius(32)

    Center {
      Text("?")
        .fontSize(32)
        .fontWeight("600")
        .color("#22c55e")
    }
    .width(64)
    .height(64)
    .backgroundColor("#f0fdf4")
    .cornerRadius(32)
  }
  .gap(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
