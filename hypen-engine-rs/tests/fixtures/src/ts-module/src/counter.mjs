// What a Hypen module looks like in JS-land. The whole "module" is this
// object — no imports of WIT types, no manual JSON encoding, no thinking
// about wasm-bindgen.
//
// Same shape (and same author intent) as @hypen-space/core's
// `app.defineState(...).onAction(...)` API today, but as a pure object
// because that's what crosses cleanly through the wasm boundary.

import { defineModule } from "./lib/define-module.mjs";

export default defineModule({
  initialState: { count: 0, history: [] },

  actions: {
    increment(state) {
      state.count += 1;
      state.history.push("inc");
    },

    decrement(state) {
      state.count -= 1;
      state.history.push("dec");
    },

    set(state, payload) {
      state.count = payload.value ?? 0;
      state.history.push(`set=${state.count}`);
    },

    reset(state) {
      state.count = 0;
      state.history = [];
    },
  },
});
