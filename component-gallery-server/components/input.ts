/**
 * Input Component Example
 * Text input field for user data.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const inputExample = {
  module: app
    .defineState({ value: "" })
    .onAction("change", ({ state, action }) => {
      state.value = (action.payload as any)?.value || "";
    })
    .build(),
  ui: `
Column {
  Text("Input Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Input")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Input(placeholder: "Type something...")
    .marginBottom(24)

  Text("Styled Inputs")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Text("Email")
        .fontSize(14)
        .fontWeight("500")
        .color("#374151")
        .marginBottom(4)
      Input(placeholder: "you@example.com", type: "email")
        .onInput("@actions.change")
        .padding(12)
        .backgroundColor("#fff")
        .border({width: 1, color: "#d1d5db"})
        .cornerRadius(8)
        .fillMaxWidth(true)
    }

    Column {
      Text("Password")
        .fontSize(14)
        .fontWeight("500")
        .color("#374151")
        .marginBottom(4)
      Input(placeholder: "Enter password", type: "password")
        .padding(12)
        .backgroundColor("#fff")
        .border({width: 1, color: "#d1d5db"})
        .cornerRadius(8)
        .fillMaxWidth(true)
    }

    Column {
      Text("Search")
        .fontSize(14)
        .fontWeight("500")
        .color("#374151")
        .marginBottom(4)
      Input(placeholder: "Search...")
        .padding(12)
        .backgroundColor("#f3f4f6")
        .cornerRadius(24)
        .fillMaxWidth(true)
    }

    Column {
      Text("Disabled Input")
        .fontSize(14)
        .fontWeight("500")
        .color("#374151")
        .marginBottom(4)
      Input(placeholder: "Cannot edit", disabled: true)
        .padding(12)
        .backgroundColor("#f9fafb")
        .border({width: 1, color: "#e5e7eb"})
        .cornerRadius(8)
        .fillMaxWidth(true)
        .opacity(0.6)
    }
  }
  .gap(16)
  .fillMaxWidth(true)

  Text("Current value: @{state.value}")
    .fontSize(14)
    .color("#666")
    .marginTop(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
