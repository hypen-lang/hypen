// Authoring API for Hypen modules written in JS/TS.
//
// The user writes:
//
//   export default defineModule({
//     initialState: { count: 0 },
//     actions: {
//       increment(state, payload) { state.count += 1; },
//       set(state, payload)       { state.count = payload.value; },
//     },
//   });
//
// The shim in `src/index.mjs` wraps this object as the WIT-exported
// `init` / `dispatch` / lifecycle functions. The user never sees WIT or
// the wire format — they write plain reducers against plain objects.
//
// Reducer semantics: `actions.foo(state, payload)` may mutate `state` in
// place (we deep-clone before handing it over) or return a new object
// (which replaces the state). Anything truthy returned replaces; otherwise
// the (possibly mutated) `state` argument is used. Matches the ergonomics
// of @hypen-space/core/app.ts but with pure-reducer semantics suitable
// for crossing a WASM boundary.

export function defineModule({ initialState, actions = {} }) {
  if (initialState === undefined) {
    throw new Error("defineModule: `initialState` is required");
  }
  return {
    initialState,
    actions,
  };
}
