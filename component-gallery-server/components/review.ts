/**
 * Renderer review fixture — exercises the fixes from the
 * renderer-subagents-applicators branch on real devices.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const reviewExample = {
  module: app
    .defineState({ taps: 0, on: true, disabled: false })
    .onAction("tap", ({ state }) => { state.taps += 1; })
    .onAction("toggleDisabled", ({ state }) => { state.disabled = !state.disabled; })
    .build(),
  ui: `
Column {
  Text("1 color wins: RED")
    .fontSize(20)
    .color("#ff0000")
    .foregroundColor("#0000ff")

  Text("2 foregroundColor alone: BLUE")
    .fontSize(20)
    .foregroundColor("#0000ff")

  Box {
    Text("3 Box justify-center")
  }
  .fillMaxWidth(true)
  .height(40)
  .backgroundColor("#e5e7eb")
  .justifyContent("center")

  Stack {
    Text("4 Stack justify-center")
  }
  .fillMaxWidth(true)
  .height(40)
  .backgroundColor("#fde68a")
  .justifyContent("center")

  VisuallyHidden {
    Text("SR-ONLY-MARKER")
  }

  Button {
    Text("5 Wide button taps=@{state.taps}")
      .color("#ffffff")
  }
  .fillMaxWidth(true)
  .height(48)
  .backgroundColor("#2563eb")
  .onClick("@actions.tap")

  Text("6 after hidden block")
    .fontSize(16)
}
.gap(12)
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
