/**
 * Card Component Example
 * A styled container with built-in padding and shadow.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const cardExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Card Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Card")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Card {
    Text("Card content")
  }
  .marginBottom(24)

  Text("Styled Cards")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Card {
      Column {
        Text("Simple Card")
          .fontSize(18)
          .fontWeight("600")
          .marginBottom(8)
        Text("This is a basic card with some content inside.")
          .color("#666")
      }
    }
    .padding(20)
    .cornerRadius(12)
    .shadow({x: 0, y: 2, blur: 8, color: "rgba(0,0,0,0.1)"})

    Card {
      Column {
        Image(src: "https://picsum.photos/300/150")
          .fillMaxWidth(true)
          .height(150)
          .cornerRadius(8)
          .marginBottom(12)
        Text("Featured Card")
          .fontSize(18)
          .fontWeight("600")
          .marginBottom(4)
        Text("A card with an image header and content below.")
          .color("#666")
          .fontSize(14)
      }
    }
    .padding(16)
    .cornerRadius(12)
    .backgroundColor("#fff")
    .border({width: 1, color: "#e5e7eb"})

    Card {
      Row {
        Column {
          Text("P")
            .color("#fff")
            .fontWeight("600")
        }
        .backgroundColor("#3b82f6")
        .width(48)
        .height(48)
        .cornerRadius(24)
        .horizontalAlignment("center")
        .verticalAlignment("center")

        Column {
          Text("Profile Card")
            .fontWeight("600")
          Text("john@example.com")
            .fontSize(14)
            .color("#666")
        }
        .gap(2)
      }
      .gap(12)
      .horizontalAlignment("center")
    }
    .padding(16)
    .cornerRadius(12)
    .backgroundColor("#f0f9ff")
    .border({width: 1, color: "#bfdbfe"})
  }
  .gap(16)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#f9fafb")
`
};
