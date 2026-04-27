/**
 * Single-File Component Example
 *
 * Demonstrates the new single-file component API with inline templates.
 * This is the recommended way to create Hypen components.
 *
 * Usage:
 *   import Counter from "./SingleFileCounter";
 *   // Counter.template contains the UI, Counter.module contains the logic
 */

import { app, hypen, state } from "../packages/core/src/index.js";

type CounterState = {
  count: number;
  message: string;
};

export default app
  .defineState<CounterState>({
    count: 0,
    message: "Click the buttons to count!",
  })
  .onCreated(({ state }) => {
    console.log("Counter component mounted with count:", state.count);
  })
  .onAction("increment", ({ state }) => {
    state.count += 1;
    state.message =
      state.count > 10
        ? "On fire!"
        : state.count > 5
          ? "Keep going!"
          : "Nice!";
  })
  .onAction("decrement", ({ state }) => {
    state.count -= 1;
    state.message =
      state.count < 0
        ? "Gone negative!"
        : state.count === 0
          ? "Back to zero"
          : "Counting down...";
  })
  .onAction("reset", ({ state }) => {
    state.count = 0;
    state.message = "Counter reset!";
  })
  .ui(hypen`
    Column {
      Text("Single-File Counter")
        .fontSize(28)
        .fontWeight("bold")
        .color("#00ff88")
        .marginBottom(24)

      Text("@{state.count}")
        .fontSize(64)
        .fontWeight("bold")
        .color("#e0e0e0")
        .marginBottom(12)

      Text("@{state.message}")
        .fontSize(14)
        .color("#888888")
        .marginBottom(32)

      Row {
        Button {
          Text("-")
            .fontSize(24)
            .fontWeight("bold")
            .color("#e0e0e0")
        }
        .onClick("@actions.decrement")
        .padding(16)
        .paddingLeft(24)
        .paddingRight(24)
        .backgroundColor("#2a2a2a")
        .borderRadius(8)
        .border("1px solid #3a3a3a")
        .cursor("pointer")

        Button {
          Text("Reset")
            .fontSize(14)
            .fontWeight("600")
            .color("#e0e0e0")
        }
        .onClick("@actions.reset")
        .padding(16)
        .paddingLeft(20)
        .paddingRight(20)
        .backgroundColor("#2a2a2a")
        .borderRadius(8)
        .border("1px solid #3a3a3a")
        .cursor("pointer")

        Button {
          Text("+")
            .fontSize(24)
            .fontWeight("bold")
            .color("#0a0a0a")
        }
        .onClick("@actions.increment")
        .padding(16)
        .paddingLeft(24)
        .paddingRight(24)
        .backgroundColor("#00ff88")
        .borderRadius(8)
        .border("none")
        .cursor("pointer")
      }
      .gap(12)
      .horizontalAlignment("center")
    }
    .padding(40)
    .backgroundColor("#1a1a1a")
    .borderRadius(16)
    .border("1px solid #2a2a2a")
    .horizontalAlignment("center")
    .maxWidth(400)
  `);
