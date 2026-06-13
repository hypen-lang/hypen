import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type CounterState = { count: number };

export const counterModule = app
  .defineState<CounterState>({ count: 0 })
  .onAction("increment", async ({ state }) => {
    state.count += 1;
  })
  .onAction("decrement", async ({ state }) => {
    state.count -= 1;
  })
  .onAction("reset", async ({ state }) => {
    state.count = 0;
  })
  .build();

export const counterUI = `
Column {
  Column {
    Text("Counter")
      .fontSize(28)
      .fontWeight("600")
      .color("#1a1a1a")

    Text("Tap to count up or down")
      .fontSize(14)
      .color("#666666")
      .marginTop(4)
  }
  .horizontalAlignment("center")

  Column {
    Text("@{state.count}")
      .fontSize(96)
      .fontWeight("700")
      .color("#2563eb")
  }
  .paddingTop(48)
  .paddingBottom(48)
  .horizontalAlignment("center")

  Row {
    Button {
      Text("-")
        .fontSize(28)
        .fontWeight("600")
        .color("#ffffff")
    }
    .onClick(@actions.decrement)
    .width(72)
    .height(72)
    .backgroundColor("#ef4444")
    .borderRadius(36)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Button {
      Text("Reset")
        .fontSize(14)
        .fontWeight("500")
        .color("#666666")
    }
    .onClick(@actions.reset)
    .paddingLeft(28)
    .paddingRight(28)
    .paddingTop(14)
    .paddingBottom(14)
    .backgroundColor("#f3f4f6")
    .borderRadius(10)
    .horizontalAlignment("center")

    Button {
      Text("+")
        .fontSize(28)
        .fontWeight("600")
        .color("#ffffff")
    }
    .onClick(@actions.increment)
    .width(72)
    .height(72)
    .backgroundColor("#22c55e")
    .borderRadius(36)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .gap(24)
  .verticalAlignment("center")
}
.fillMaxSize()
.backgroundColor("#ffffff")
.horizontalAlignment("center")
.verticalAlignment("center")
.padding(24)
`;
