/**
 * Paragraph Component Example
 * Block of text with paragraph styling.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const paragraphExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Paragraph Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Paragraph")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Paragraph {
    Text("This is a paragraph of text. It contains multiple sentences that form a coherent block of content.")
  }
  .marginBottom(24)

  Text("Styled Paragraphs")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Heading(level: 2) {
      Text("Article Title")
    }
    .marginBottom(16)

    Paragraph {
      Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.")
    }
    .lineHeight(1.7)
    .color("#374151")
    .marginBottom(16)

    Paragraph {
      Text("Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.")
    }
    .lineHeight(1.7)
    .color("#374151")
    .marginBottom(16)

    Paragraph {
      Text("Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis.")
    }
    .lineHeight(1.7)
    .color("#374151")
  }
  .padding(24)
  .backgroundColor("#fff")
  .cornerRadius(12)
  .border({width: 1, color: "#e5e7eb"})
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Paragraph with First Letter Drop Cap")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Text("L")
        .fontSize(48)
        .fontWeight("700")
        .color("#3b82f6")
        .lineHeight(1)
        .marginRight(8)

      Paragraph {
        Text("orem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.")
      }
      .lineHeight(1.6)
      .color("#374151")
      .weight(1)
    }
    .horizontalAlignment("start")
  }
  .padding(24)
  .backgroundColor("#f0f9ff")
  .cornerRadius(12)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
