/**
 * Counter Example
 * Interactive counter with increment and decrement buttons.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const counterExample = {
  module: app
    .defineState({ count: 0 })
    .onAction("increment", async ({ state }) => {
      state.count++;
    })
    .onAction("decrement", async ({ state }) => {
      state.count--;
    })
    .build(),

  ui: `
Column {
  Text("Total Count: @{state.count}")
    .fontSize(24)
    .color("#fff")

  Text("Click to interact!")
    .fontSize(24)
    .color("#fff")
    .margin(16)

  Row {
    Button {
      Text("Decrement")
        .padding(12)
        .color("black")
    }
      .cornerRadius(12)
      .backgroundColor("#fbcfe8")
      .fontWeight("500")
      .onClick(@actions.decrement)

    Button {
      Text("Increment")
        .padding(12)
        .color("black")
    }
      .onClick(@actions.increment)
      .backgroundColor("#6bff9d")
      .cornerRadius(8)
  }
    .gap(12)
}
  .padding(24)
  .horizontalAlignment("center")
  .verticalAlignment("center")
  .fillMaxSize(true)
  .backgroundColor("#000000")
  .color("#fff")
`
};
