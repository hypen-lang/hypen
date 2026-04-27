/**
 * Slider Component Example
 * Range slider input.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const sliderExample = {
  module: app
    .defineState({ volume: 50, brightness: 75 })
    .onAction("changeVolume", ({ state, action }) => {
      state.volume = (action.payload as any)?.value || 50;
    })
    .onAction("changeBrightness", ({ state, action }) => {
      state.brightness = (action.payload as any)?.value || 75;
    })
    .build(),
  ui: `
Column {
  Text("Slider Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Slider")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Slider()
    .fillMaxWidth(true)
    .marginBottom(24)

  Text("Styled Sliders")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Row {
        Text("Volume")
          .fontWeight("500")
        Spacer()
        Text("@{state.volume}%")
          .color("#3b82f6")
          .fontWeight("500")
      }
      .marginBottom(8)
      Slider(value: "@{state.volume}", min: 0, max: 100)
        .onInput("@actions.changeVolume")
        .fillMaxWidth(true)
    }
    .padding(16)
    .backgroundColor("#fff")
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})

    Column {
      Row {
        Text("Brightness")
          .fontWeight("500")
        Spacer()
        Text("@{state.brightness}%")
          .color("#f59e0b")
          .fontWeight("500")
      }
      .marginBottom(8)
      Slider(value: "@{state.brightness}", min: 0, max: 100)
        .onInput("@actions.changeBrightness")
        .fillMaxWidth(true)
    }
    .padding(16)
    .backgroundColor("#fff")
    .cornerRadius(8)
    .border({width: 1, color: "#e5e7eb"})

    Column {
      Text("Disabled Slider")
        .fontWeight("500")
        .marginBottom(8)
      Slider(value: 30, disabled: true)
        .fillMaxWidth(true)
        .opacity(0.5)
    }
    .padding(16)
    .backgroundColor("#f9fafb")
    .cornerRadius(8)
  }
  .gap(12)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
