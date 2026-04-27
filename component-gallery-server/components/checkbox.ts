/**
 * Checkbox Component Example
 * Toggle checkbox input.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const checkboxExample = {
  module: app
    .defineState({ checked1: false, checked2: true, checked3: false })
    .onAction("toggle1", ({ state }) => { state.checked1 = !state.checked1; })
    .onAction("toggle2", ({ state }) => { state.checked2 = !state.checked2; })
    .onAction("toggle3", ({ state }) => { state.checked3 = !state.checked3; })
    .build(),
  ui: `
Column {
  Text("Checkbox Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Checkbox")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Checkbox()
    .marginBottom(24)

  Text("Styled Checkboxes")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Checkbox(checked: "@{state.checked1}")
        .onChange("@actions.toggle1")
      Text("Accept terms and conditions")
        .marginLeft(8)
    }
    .horizontalAlignment("center")

    Row {
      Checkbox(checked: "@{state.checked2}")
        .onChange("@actions.toggle2")
      Text("Subscribe to newsletter")
        .marginLeft(8)
    }
    .horizontalAlignment("center")

    Row {
      Checkbox(checked: "@{state.checked3}")
        .onChange("@actions.toggle3")
      Text("Remember me")
        .marginLeft(8)
    }
    .horizontalAlignment("center")
  }
  .gap(12)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Checkbox in Card")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Column {
        Text("Option A")
          .fontWeight("500")
        Text("Description for option A")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
      Checkbox()
    }
    .padding(16)
    .backgroundColor("#fff")
    .border({width: 1, color: "#e5e7eb"})
    .cornerRadius(8)
    .horizontalAlignment("center")

    Row {
      Column {
        Text("Option B")
          .fontWeight("500")
        Text("Description for option B")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
      Checkbox(checked: true)
    }
    .padding(16)
    .backgroundColor("#eff6ff")
    .border({width: 2, color: "#3b82f6"})
    .cornerRadius(8)
    .horizontalAlignment("center")
  }
  .gap(8)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
`
};
