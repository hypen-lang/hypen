import { expect, test } from "bun:test";
import { actionLogEntry } from "./action-log";

test("unwraps the renderer's __hypen_dispatch envelope", () => {
  expect(actionLogEntry("__hypen_dispatch", { node: "42", action: "tap", payload: { type: "click" } })).toEqual({
    name: "tap",
    payload: { type: "click" },
  });
});

test("passes other actions through", () => {
  expect(actionLogEntry("increment", { by: 1 })).toEqual({ name: "increment", payload: { by: 1 } });
  expect(actionLogEntry("__hypen_dispatch", null)).toEqual({ name: "__hypen_dispatch", payload: null });
});
