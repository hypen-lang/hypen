/**
 * Counter component module
 */
import { app } from "../../../../packages/core/src/app.js";

type CounterState = {
  count: number;
};

export default app
  .defineState<CounterState>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count++;
  })
  .onAction("decrement", ({ state }) => {
    state.count--;
  })
  .onAction("reset", ({ state }) => {
    state.count = 0;
  })
  .build();
