import { app } from "@hypen-space/core";

type AppState = {
  count: number;
};

export default app
  .defineState<AppState>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count++;
  })
  .onAction("decrement", ({ state }) => {
    state.count--;
  })
  .build();
