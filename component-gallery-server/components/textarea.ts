/**
 * TextArea Component Example
 * Multi-line text input field.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const textareaExample = {
  module: app.defineState({ text: "" }).build(),
  ui: `
Column {
  Text("TextArea Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw TextArea")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  TextArea(placeholder: "Enter text...")
    .height(80)
    .marginBottom(24)

  Text("Styled TextAreas")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Text("Message")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      TextArea(placeholder: "Write your message here...")
        .padding(12)
        .backgroundColor("#fff")
        .border({width: 1, color: "#d1d5db"})
        .cornerRadius(8)
        .height(120)
        .fillMaxWidth(true)
    }

    Column {
      Text("Notes")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      TextArea(placeholder: "Add notes...")
        .padding(12)
        .backgroundColor("#fffbeb")
        .border({width: 1, color: "#fde68a"})
        .cornerRadius(8)
        .height(100)
        .fillMaxWidth(true)
    }

    Column {
      Text("Code")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      TextArea(placeholder: "// Enter code...")
        .padding(12)
        .backgroundColor("#1f2937")
        .color("#f9fafb")
        .cornerRadius(8)
        .height(120)
        .fillMaxWidth(true)
        .fontFamily("monospace")
    }
  }
  .gap(16)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
