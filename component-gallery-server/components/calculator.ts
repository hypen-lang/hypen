/**
 * Calculator Example
 * Fully functional calculator with a 4x5 button grid.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

type Button = {
  label: string;
  type: string;
  textColor: string;
  bg: string;
  fontSize: number;
  span: string;
};

type CalculatorState = {
  display: string;
  previousValue: number | null;
  operation: string;
  waitingForOperand: boolean;
  buttons: Button[];
};

const gray = { textColor: "#1a1a1a", bg: "#a5a5a5", fontSize: 24 };
const dark = { textColor: "#ffffff", bg: "#333333", fontSize: 28 };
const orange = { textColor: "#ffffff", bg: "#f59e0b", fontSize: 28 };

const buttons: Button[] = [
  { label: "C",   type: "func",    ...gray,   span: "span 1" },
  { label: "+/-", type: "func",    ...gray,   span: "span 1" },
  { label: "%",   type: "func",    ...gray,   span: "span 1" },
  { label: "÷",   type: "op",      ...orange, span: "span 1" },
  { label: "7",   type: "digit",   ...dark,   span: "span 1" },
  { label: "8",   type: "digit",   ...dark,   span: "span 1" },
  { label: "9",   type: "digit",   ...dark,   span: "span 1" },
  { label: "×",   type: "op",      ...orange, span: "span 1" },
  { label: "4",   type: "digit",   ...dark,   span: "span 1" },
  { label: "5",   type: "digit",   ...dark,   span: "span 1" },
  { label: "6",   type: "digit",   ...dark,   span: "span 1" },
  { label: "-",   type: "op",      ...orange, span: "span 1" },
  { label: "1",   type: "digit",   ...dark,   span: "span 1" },
  { label: "2",   type: "digit",   ...dark,   span: "span 1" },
  { label: "3",   type: "digit",   ...dark,   span: "span 1" },
  { label: "+",   type: "op",      ...orange, span: "span 1" },
  { label: "0",   type: "digit",   ...dark,   span: "span 2" },
  { label: ".",   type: "decimal", ...dark,   span: "span 1" },
  { label: "=",   type: "equals",  ...orange, span: "span 1" },
];

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(8).replace(/\.?0+$/, '');
}

function calculate(prev: number, current: number, op: string): number {
  switch (op) {
    case "+": return prev + current;
    case "-": return prev - current;
    case "×": return prev * current;
    case "÷": return current !== 0 ? prev / current : 0;
    default: return current;
  }
}

export const calculatorExample = {
  module: app
    .defineState<CalculatorState>({
      display: "0",
      previousValue: null,
      operation: "",
      waitingForOperand: false,
      buttons,
    })
    .onAction<{ type: string; value: string }>("buttonPress", async ({ action, state }) => {
      const { type, value } = action.payload;

      switch (type) {
        case "digit": {
          if (state.waitingForOperand) {
            state.display = value;
            state.waitingForOperand = false;
          } else {
            state.display = state.display === "0" ? value : state.display + value;
          }
          break;
        }
        case "op": {
          const current = parseFloat(state.display);
          if (state.previousValue !== null && state.operation && !state.waitingForOperand) {
            const result = calculate(state.previousValue, current, state.operation);
            state.display = formatNumber(result);
            state.previousValue = result;
          } else {
            state.previousValue = current;
          }
          state.operation = value;
          state.waitingForOperand = true;
          break;
        }
        case "equals": {
          if (state.previousValue !== null && state.operation) {
            const result = calculate(state.previousValue, parseFloat(state.display), state.operation);
            state.display = formatNumber(result);
            state.previousValue = null;
            state.operation = "";
            state.waitingForOperand = true;
          }
          break;
        }
        case "decimal": {
          if (state.waitingForOperand) {
            state.display = "0.";
            state.waitingForOperand = false;
          } else if (!state.display.includes(".")) {
            state.display += ".";
          }
          break;
        }
        case "func": {
          if (value === "C") {
            state.display = "0";
            state.previousValue = null;
            state.operation = "";
            state.waitingForOperand = false;
          } else if (value === "+/-") {
            state.display = formatNumber(parseFloat(state.display) * -1);
          } else if (value === "%") {
            state.display = formatNumber(parseFloat(state.display) / 100);
          }
          break;
        }
      }
    })
    .build(),

  ui: `
Column {
  Column {
    Text("@{state.operation}")
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

  Grid {
    ForEach(@state.buttons) {
      Button {
        Text("@{item.label}")
          .fontSize("@{item.fontSize}")
          .color("@{item.textColor}")
      }
        .onClick(@actions.buttonPress, type: "@{item.type}", value: "@{item.label}")
        .height(72)
        .backgroundColor("@{item.bg}")
        .horizontalAlignment("center")
        .verticalAlignment("center")
        .gridColumn("@{item.span}")
    }
  }
    .gridColumns(4)
    .gap(1)
    .backgroundColor("#000000")
    .fillMaxWidth(true)
}
  .width("100%")
  .height("100%")
  .backgroundColor("#1a1a1a")
`
};
