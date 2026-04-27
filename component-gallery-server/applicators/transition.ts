/**
 * transition Applicator Example
 * Adds CSS transitions for smooth animations.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const transitionExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("transition Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Transition properties")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("transition: all 0.3s ease")
        .color("#fff")
    }
    .backgroundColor("#3b82f6")
    .padding(16)
    .cornerRadius(8)
    .transition("all 0.3s ease")
    .fillMaxWidth(true)

    Stack {
      Text("transition: transform 0.2s")
        .color("#fff")
    }
    .backgroundColor("#22c55e")
    .padding(16)
    .cornerRadius(8)
    .transition("transform 0.2s")
    .fillMaxWidth(true)

    Stack {
      Text("transition: background-color 0.5s")
        .color("#fff")
    }
    .backgroundColor("#f59e0b")
    .padding(16)
    .cornerRadius(8)
    .transition("background-color 0.5s")
    .fillMaxWidth(true)

    Stack {
      Text("transition: opacity 0.3s ease-in-out")
        .color("#fff")
    }
    .backgroundColor("#8b5cf6")
    .padding(16)
    .cornerRadius(8)
    .transition("opacity 0.3s ease-in-out")
    .fillMaxWidth(true)
  }
  .gap(12)
  .marginBottom(24)

  Text("Timing functions")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Text("ease")
        .fontSize(12)
        .width(80)
      Stack {}
        .backgroundColor("#ef4444")
        .height(8)
        .weight(1)
        .cornerRadius(4)
        .transition("all 0.5s ease")
    }
    .horizontalAlignment("center")
    .gap(8)

    Row {
      Text("ease-in")
        .fontSize(12)
        .width(80)
      Stack {}
        .backgroundColor("#ec4899")
        .height(8)
        .weight(1)
        .cornerRadius(4)
        .transition("all 0.5s ease-in")
    }
    .horizontalAlignment("center")
    .gap(8)

    Row {
      Text("ease-out")
        .fontSize(12)
        .width(80)
      Stack {}
        .backgroundColor("#14b8a6")
        .height(8)
        .weight(1)
        .cornerRadius(4)
        .transition("all 0.5s ease-out")
    }
    .horizontalAlignment("center")
    .gap(8)

    Row {
      Text("ease-in-out")
        .fontSize(12)
        .width(80)
      Stack {}
        .backgroundColor("#6366f1")
        .height(8)
        .weight(1)
        .cornerRadius(4)
        .transition("all 0.5s ease-in-out")
    }
    .horizontalAlignment("center")
    .gap(8)

    Row {
      Text("linear")
        .fontSize(12)
        .width(80)
      Stack {}
        .backgroundColor("#f97316")
        .height(8)
        .weight(1)
        .cornerRadius(4)
        .transition("all 0.5s linear")
    }
    .horizontalAlignment("center")
    .gap(8)
  }
  .gap(8)
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Note: Hover over elements to see transitions in action")
    .fontSize(12)
    .color("#9ca3af")
    .fontStyle("italic")
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
