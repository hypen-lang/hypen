/**
 * Link Component Example
 * Clickable link for navigation.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const linkExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Link Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Link")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Link(href: "https://example.com") {
    Text("Click here")
  }
  .marginBottom(24)

  Text("Styled Links")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Link(href: "https://example.com") {
      Text("Primary Link")
        .color("#3b82f6")
        .fontSize(16)
    }

    Link(href: "https://example.com") {
      Text("Underlined Link")
        .color("#3b82f6")
        .textDecoration("underline")
    }

    Link(href: "https://example.com") {
      Row {
        Text("Link with arrow")
          .color("#3b82f6")
          .fontWeight("500")
        Text("->")
          .color("#3b82f6")
          .marginLeft(4)
      }
    }

    Link(href: "https://example.com") {
      Row {
        Text("Button Link")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#3b82f6")
      .padding(12)
      .paddingHorizontal(24)
      .cornerRadius(8)
    }

    Link(href: "https://example.com") {
      Row {
        Text("Card Link")
          .fontWeight("500")
          .marginBottom(4)
        Text("Click to learn more")
          .fontSize(14)
          .color("#666")
      }
      .backgroundColor("#f9fafb")
      .padding(16)
      .cornerRadius(8)
      .border({width: 1, color: "#e5e7eb"})
      .fillMaxWidth(true)
    }
  }
  .gap(16)
  .horizontalAlignment("start")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
