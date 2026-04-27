/**
 * Container Component Example
 * A generic container for grouping elements.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const containerExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Container Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Container")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Container {
    Text("Inside a Container")
  }
  .marginBottom(24)

  Text("Styled Containers")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Container {
      Text("Simple styled container")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(20)
    .cornerRadius(8)

    Container {
      Column {
        Text("Nested Content")
          .fontWeight("600")
        Text("With multiple children")
          .fontSize(14)
          .color("#666")
      }
      .gap(4)
    }
    .backgroundColor("#f0f9ff")
    .padding(20)
    .cornerRadius(8)
    .border({width: 1, color: "#bfdbfe"})

    Container {
      Row {
        Container {
          Text("A")
            .color("#fff")
            .fontWeight("600")
        }
        .backgroundColor("#ef4444")
        .padding(12)
        .cornerRadius(4)

        Container {
          Text("B")
            .color("#fff")
            .fontWeight("600")
        }
        .backgroundColor("#22c55e")
        .padding(12)
        .cornerRadius(4)

        Container {
          Text("C")
            .color("#fff")
            .fontWeight("600")
        }
        .backgroundColor("#f59e0b")
        .padding(12)
        .cornerRadius(4)
      }
      .gap(8)
    }
    .backgroundColor("#fafafa")
    .padding(16)
    .cornerRadius(8)
  }
  .gap(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
