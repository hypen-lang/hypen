import { app, isHttpCompletion, isModuleHttpError } from "@hypen-space/core";

type S = {
  status: string;
  body: string;
  contentType: string;
  tag: string | null;
  completions: number;
  refused: string | null;
};
type LoadPayload = { url?: string; uncaught?: boolean };

// A module that fetches over `hypen:http/deferred` through the shim's
// `context.http`. Built twice by the E2E test: with the `http` grant (the
// component imports the interface) and without (it must not).
export default app
  .defineState<S>({ status: "idle", body: "", contentType: "", tag: null, completions: 0, refused: null })
  .onAction("load", ({ action, state, context }) => {
    const { url = "https://api.example.test/hello", uncaught = false } = (action.payload ?? {}) as LoadPayload;
    state.status = "loading";
    if (uncaught) {
      context.http!.get(url, { then: "loaded" });
      return;
    }
    try {
      context.http!.get(url, { then: "loaded", tag: "get", headers: { accept: "application/json" } });
    } catch (err) {
      if (!isModuleHttpError(err)) throw err;
      state.status = "refused";
      state.refused = `${err.code}: ${err.message}`;
    }
  })
  .onAction("post", ({ state, context }) => {
    state.status = "loading";
    context.http!.send(
      { url: "https://api.example.test/echo", body: { name: "kettle", qty: 2 }, timeoutMs: 5000 },
      { then: "loaded", tag: "post" }
    );
  })
  .onAction("loaded", ({ action, state }) => {
    const response = action.payload;
    if (!isHttpCompletion(response)) return;
    state.completions += 1;
    state.tag = response.tag;
    if (!response.ok) {
      state.status = `failed:${response.error.kind}`;
      return;
    }
    state.status = `http ${response.status}`;
    state.body = response.body;
    state.contentType = response.headers["content-type"] ?? "";
  })
  .build();
