import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type CalculatorState = {
  display: string;
  previousValue: number | null;
  operation: string | null;
  waitingForOperand: boolean;
};

export const calculatorModule = app
  .defineState<CalculatorState>({
    display: "0",
    previousValue: null,
    operation: null,
    waitingForOperand: false,
  })
  .onAction("digit", async ({ action, state }) => {
    const digit = action.payload?.value ?? "0";
    if (state.waitingForOperand) {
      state.display = digit;
      state.waitingForOperand = false;
    } else {
      state.display = state.display === "0" ? digit : state.display + digit;
    }
  })
  .onAction("operation", async ({ action, state }) => {
    const op = action.payload?.value;
    const current = parseFloat(state.display);

    if (state.previousValue !== null && state.operation && !state.waitingForOperand) {
      let result = state.previousValue;
      switch (state.operation) {
        case "+": result = state.previousValue + current; break;
        case "-": result = state.previousValue - current; break;
        case "×": result = state.previousValue * current; break;
        case "÷": result = current !== 0 ? state.previousValue / current : 0; break;
      }
      state.display = formatNumber(result);
      state.previousValue = result;
    } else {
      state.previousValue = current;
    }
    state.operation = op;
    state.waitingForOperand = true;
  })
  .onAction("equals", async ({ state }) => {
    if (state.previousValue !== null && state.operation) {
      const current = parseFloat(state.display);
      let result = state.previousValue;
      switch (state.operation) {
        case "+": result = state.previousValue + current; break;
        case "-": result = state.previousValue - current; break;
        case "×": result = state.previousValue * current; break;
        case "÷": result = current !== 0 ? state.previousValue / current : 0; break;
      }
      state.display = formatNumber(result);
      state.previousValue = null;
      state.operation = null;
      state.waitingForOperand = true;
    }
  })
  .onAction("clear", async ({ state }) => {
    state.display = "0";
    state.previousValue = null;
    state.operation = null;
    state.waitingForOperand = false;
  })
  .onAction("decimal", async ({ state }) => {
    if (state.waitingForOperand) {
      state.display = "0.";
      state.waitingForOperand = false;
    } else if (!state.display.includes(".")) {
      state.display += ".";
    }
  })
  .build();

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(8).replace(/\.?0+$/, '');
}

export const calculatorUI = `
Column {
  Column {
    Text("@{state.operation ?? ''}")
      .fontSize(24)
      .color("rgba(255,255,255,0.5)")
      .textAlign("right")

    Text("@{state.display}")
      .fontSize(64)
      .fontWeight("300")
      .color("#ffffff")
      .textAlign("right")
  }
    .padding(24)
    .horizontalAlignment("flex-end")
    .verticalAlignment("flex-end")
    .flex(1)
    .backgroundColor("#1a1a1a")

  Column {
    Row {
      Button {
        Text("C")
          .fontSize(24)
          .color("#1a1a1a")
      }
        .onClick(@actions.clear)
        .flex(1)
        .height(72)
        .backgroundColor("#a5a5a5")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("+/-")
          .fontSize(24)
          .color("#1a1a1a")
      }
        .flex(1)
        .height(72)
        .backgroundColor("#a5a5a5")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("%")
          .fontSize(24)
          .color("#1a1a1a")
      }
        .flex(1)
        .height(72)
        .backgroundColor("#a5a5a5")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("÷")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.operation, value: "÷")
        .flex(1)
        .height(72)
        .backgroundColor("#f59e0b")
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }

    Row {
      Button {
        Text("7")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "7")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("8")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "8")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("9")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "9")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("×")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.operation, value: "×")
        .flex(1)
        .height(72)
        .backgroundColor("#f59e0b")
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }

    Row {
      Button {
        Text("4")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "4")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("5")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "5")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("6")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "6")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("-")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.operation, value: "-")
        .flex(1)
        .height(72)
        .backgroundColor("#f59e0b")
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }

    Row {
      Button {
        Text("1")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "1")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("2")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "2")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("3")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "3")
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("+")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.operation, value: "+")
        .flex(1)
        .height(72)
        .backgroundColor("#f59e0b")
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }

    Row {
      Button {
        Text("0")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.digit, value: "0")
        .flex(2)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text(".")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.decimal)
        .flex(1)
        .height(72)
        .backgroundColor("#333333")
        .horizontalAlignment("center")
        .verticalAlignment("center")

      Button {
        Text("=")
          .fontSize(28)
          .color("#ffffff")
      }
        .onClick(@actions.equals)
        .flex(1)
        .height(72)
        .backgroundColor("#f59e0b")
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }
  }
    .gap(1)
    .backgroundColor("#000000")
}
  .fillMaxSize()
  .backgroundColor("#1a1a1a")
`;
