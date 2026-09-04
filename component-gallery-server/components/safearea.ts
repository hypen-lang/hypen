/**
 * SafeArea Component Example
 * Full-size vertical container padded by the device safe-area insets.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const safeareaExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("SafeArea Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("All Edges (default) - header bar + content + bottom bar")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Container {
    SafeArea {
      Row {
        Text("Screen Title")
          .fontSize(16)
          .fontWeight("600")
          .color("#ffffff")
        Spacer()
        Text("Done")
          .fontSize(14)
          .color("#93c5fd")
      }
      .padding(16)
      .fillMaxWidth(true)
      .backgroundColor("#1f2937")
      .verticalAlignment("center")

      Column {
        Text("Content")
          .fontSize(18)
          .fontWeight("600")
          .color("#111827")
        Text("Padded away from the notch, the status bar and the home indicator.")
          .fontSize(14)
          .color("#4b5563")
      }
      .weight(1)
      .gap(8)
      .padding(16)

      Row {
        Text("Home")
          .fontSize(14)
          .color("#2563eb")
        Spacer()
        Text("Search")
          .fontSize(14)
          .color("#6b7280")
        Spacer()
        Text("Profile")
          .fontSize(14)
          .color("#6b7280")
      }
      .padding(16)
      .fillMaxWidth(true)
      .backgroundColor("#f3f4f6")
      .verticalAlignment("center")
    }
    .backgroundColor("#ffffff")
  }
  .height(360)
  .fillMaxWidth(true)
  .backgroundColor("#e5e7eb")
  .cornerRadius(12)
  .overflow("hidden")
  .marginBottom(24)

  Text('Top Edge Only - edges: ["top"]')
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Container {
    SafeArea(edges: ["top"]) {
      Row {
        Text("Top inset applied")
          .fontSize(14)
          .fontWeight("600")
          .color("#ffffff")
      }
      .padding(12)
      .fillMaxWidth(true)
      .backgroundColor("#6366f1")

      Column {
        Text("Left, right and bottom run to the screen edge")
          .fontSize(14)
          .color("#4b5563")
      }
      .weight(1)
      .padding(12)

      Row {
        Text("Full-bleed bottom bar")
          .fontSize(13)
          .color("#ffffff")
      }
      .padding(12)
      .fillMaxWidth(true)
      .backgroundColor("#111827")
    }
    .backgroundColor("#ffffff")
  }
  .height(240)
  .fillMaxWidth(true)
  .backgroundColor("#e5e7eb")
  .cornerRadius(12)
  .overflow("hidden")
  .marginBottom(24)

  Text('Horizontal Edges Only - edges: ["left", "right"]')
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Container {
    SafeArea(edges: ["left", "right"]) {
      Column {
        Text("Side gutters respected")
          .fontSize(14)
          .fontWeight("600")
          .color("#111827")
        Text("Top and bottom are left to the app to handle.")
          .fontSize(13)
          .color("#4b5563")
      }
      .weight(1)
      .gap(6)
      .padding(12)
      .backgroundColor("#fef3c7")
    }
    .backgroundColor("#ffffff")
  }
  .height(160)
  .fillMaxWidth(true)
  .backgroundColor("#e5e7eb")
  .cornerRadius(12)
  .overflow("hidden")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
