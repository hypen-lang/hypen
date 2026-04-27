/**
 * border Applicator Example
 * Adds borders around elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const borderExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("border Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Border widths")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("1px")
        .fontSize(12)
    }
    .border({width: 1, color: "#3b82f6"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("2px")
        .fontSize(12)
    }
    .border({width: 2, color: "#3b82f6"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("3px")
        .fontSize(12)
    }
    .border({width: 3, color: "#3b82f6"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("4px")
        .fontSize(12)
    }
    .border({width: 4, color: "#3b82f6"})
    .padding(16)
    .cornerRadius(4)
  }
  .gap(12)
  .marginBottom(24)

  Text("Border colors")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Stack {
      Text("Blue")
        .fontSize(12)
    }
    .border({width: 2, color: "#3b82f6"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("Green")
        .fontSize(12)
    }
    .border({width: 2, color: "#22c55e"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("Red")
        .fontSize(12)
    }
    .border({width: 2, color: "#ef4444"})
    .padding(16)
    .cornerRadius(4)

    Stack {
      Text("Purple")
        .fontSize(12)
    }
    .border({width: 2, color: "#8b5cf6"})
    .padding(16)
    .cornerRadius(4)
  }
  .gap(12)
  .marginBottom(24)

  Text("Border styles")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Solid")
    }
    .border({width: 2, color: "#3b82f6", style: "solid"})
    .padding(12)
    .cornerRadius(4)
    .fillMaxWidth(true)

    Stack {
      Text("Dashed")
    }
    .border({width: 2, color: "#22c55e", style: "dashed"})
    .padding(12)
    .cornerRadius(4)
    .fillMaxWidth(true)

    Stack {
      Text("Dotted")
    }
    .border({width: 2, color: "#f59e0b", style: "dotted"})
    .padding(12)
    .cornerRadius(4)
    .fillMaxWidth(true)
  }
  .gap(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
