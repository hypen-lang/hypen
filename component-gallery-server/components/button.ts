/**
 * Button Component Example
 * Interactive button with click handling.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const buttonExample = {
  module: app
    .defineState({ clicks: 0 })
    .onAction("click", ({ state }) => {
      state.clicks += 1;
    })
    .build(),
  ui: `
Column {
  Text("Button Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Button")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Button {
    Text("Click Me")
  }
  .marginBottom(24)

  Text("Styled Buttons")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Button {
      Text("Primary Button")
        .color("#fff")
        .fontWeight("600")
    }
    .onClick("@actions.click")
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("center")

    Button {
      Text("Secondary Button")
        .color("#3b82f6")
        .fontWeight("600")
    }
    .onClick("@actions.click")
    .backgroundColor("#eff6ff")
    .padding(16)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("center")
    .border({width: 1, color: "#3b82f6"})

    Button {
      Text("Danger Button")
        .color("#fff")
        .fontWeight("600")
    }
    .onClick("@actions.click")
    .backgroundColor("#ef4444")
    .padding(16)
    .cornerRadius(8)
    .fillMaxWidth(true)
    .horizontalAlignment("start")

    Button {
      Text("Rounded Button")
        .color("#fff")
        .fontWeight("600")
    }
    .onClick("@actions.click")
    .backgroundColor("#8b5cf6")
    .padding(16)
    .cornerRadius(24)
    .fillMaxWidth(true)
    .horizontalAlignment("end")
  }
  .gap(12)
  .fillMaxWidth(true)

  Text("Click count: @{state.clicks}")
    .fontSize(16)
    .color("#666")
    .marginTop(24)
    .textAlign("center")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
