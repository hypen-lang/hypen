/**
 * backgroundColor Applicator Example
 * Sets the background color of an element.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const backgroundColorExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("backgroundColor Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Solid colors")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Blue background")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Green background")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Red background")
        .color("#fff")
    }
    .backgroundColor("#ef4444")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Amber background")
        .color("#fff")
    }
    .backgroundColor("#f59e0b")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Purple background")
        .color("#fff")
    }
    .backgroundColor("#8b5cf6")
    .padding(16)
    .cornerRadius(8)
  }
  .gap(8)
  .marginBottom(24)

  Text("Light variations")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Light blue")
        .color("#3b82f6")
    }
    .backgroundColor("#eff6ff")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Light green")
        .color("#22c55e")
    }
    .backgroundColor("#f0fdf4")
    .padding(16)
    .cornerRadius(8)

    Stack {
      Text("Light red")
        .color("#ef4444")
    }
    .backgroundColor("#fef2f2")
    .padding(16)
    .cornerRadius(8)
  }
  .gap(8)
  .marginBottom(24)

  Text("Transparent backgrounds")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Stack {
        Text("rgba(0,0,0,0.1)")
          .color("#333")
      }
      .backgroundColor("rgba(0,0,0,0.1)")
      .padding(12)
      .cornerRadius(4)

      Stack {
        Text("rgba(0,0,0,0.3)")
          .color("#333")
      }
      .backgroundColor("rgba(0,0,0,0.3)")
      .padding(12)
      .cornerRadius(4)

      Stack {
        Text("rgba(0,0,0,0.5)")
          .color("#fff")
      }
      .backgroundColor("rgba(0,0,0,0.5)")
      .padding(12)
      .cornerRadius(4)
    }
    .gap(8)
  }
  .padding(16)
  .backgroundColor("#e0e7ff")
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
