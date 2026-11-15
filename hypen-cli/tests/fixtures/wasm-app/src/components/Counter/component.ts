import { app } from "@hypen-space/core";
type S = { count: number };
export default app
  .defineState<S>({ count: 0 })
  .onAction("increment", ({ state }) => { state.count++; })
  .onAction("decrement", ({ state }) => { state.count--; })
  .build();
