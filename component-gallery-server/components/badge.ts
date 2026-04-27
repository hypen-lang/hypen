/**
 * Badge Component Example
 * Small status indicator or label.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const badgeExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Badge Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Badge")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Badge {
    Text("Badge")
  }
  .marginBottom(24)

  Text("Styled Badges")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Badge {
      Text("New")
        .fontSize(12)
        .color("#fff")
        .fontWeight("500")
    }
    .backgroundColor("#3b82f6")
    .padding(4)
    .paddingHorizontal(8)
    .cornerRadius(4)

    Badge {
      Text("Sale")
        .fontSize(12)
        .color("#fff")
        .fontWeight("500")
    }
    .backgroundColor("#ef4444")
    .padding(4)
    .paddingHorizontal(8)
    .cornerRadius(4)

    Badge {
      Text("Popular")
        .fontSize(12)
        .color("#fff")
        .fontWeight("500")
    }
    .backgroundColor("#22c55e")
    .padding(4)
    .paddingHorizontal(8)
    .cornerRadius(4)

    Badge {
      Text("Pro")
        .fontSize(12)
        .color("#fff")
        .fontWeight("500")
    }
    .backgroundColor("#8b5cf6")
    .padding(4)
    .paddingHorizontal(8)
    .cornerRadius(4)
  }
  .gap(8)
  .marginBottom(24)

  Text("Rounded Badges (Pills)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Badge {
      Text("Pending")
        .fontSize(12)
        .color("#f59e0b")
        .fontWeight("500")
    }
    .backgroundColor("#fef3c7")
    .padding(4)
    .paddingHorizontal(12)
    .cornerRadius(12)

    Badge {
      Text("Approved")
        .fontSize(12)
        .color("#22c55e")
        .fontWeight("500")
    }
    .backgroundColor("#dcfce7")
    .padding(4)
    .paddingHorizontal(12)
    .cornerRadius(12)

    Badge {
      Text("Rejected")
        .fontSize(12)
        .color("#ef4444")
        .fontWeight("500")
    }
    .backgroundColor("#fee2e2")
    .padding(4)
    .paddingHorizontal(12)
    .cornerRadius(12)
  }
  .gap(8)
  .marginBottom(24)

  Text("Badge with Icon")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Badge {
      Row {
        Text("5")
          .fontSize(12)
          .color("#fff")
          .fontWeight("600")
      }
    }
    .backgroundColor("#ef4444")
    .width(20)
    .height(20)
    .cornerRadius(10)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Badge {
      Row {
        Text("99+")
          .fontSize(10)
          .color("#fff")
          .fontWeight("600")
      }
    }
    .backgroundColor("#3b82f6")
    .padding(2)
    .paddingHorizontal(6)
    .cornerRadius(10)
  }
  .gap(12)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
