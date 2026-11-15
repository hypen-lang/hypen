import { app, isHttpCompletion, isModuleHttpError } from "@hypen-space/core";

/**
 * A module that makes an HTTP request — written in TypeScript, built to a
 * WebAssembly component (`hypen build --target wasm`).
 *
 * A module running as a component is a synchronous reducer: a handler cannot
 * `await fetch(...)`. So it *queues* the request and names the action that
 * should receive the response; the host performs the request after the
 * handler returns and dispatches that action with the outcome.
 *
 *   refresh  →  context.http.get(url, { then: "loaded" })   (returns at once)
 *   …the host fetches…
 *   loaded   ←  { ok: true, status, headers, body, bodyEncoding, tag }
 *            or { ok: false, error: { kind, message }, tag }
 */

type State = {
  /** Where the forecast comes from. scripts/api.ts serves it locally. */
  endpoint: string;
  city: string;
  temperature: string;
  summary: string;
  /** "idle", "loading…", "ok", or what went wrong. */
  status: string;
  requests: number;
};

/** What scripts/api.ts answers with. */
type Forecast = { city: string; tempC: number; summary: string };

/** `refresh` may carry these (scripts/drive.ts uses them); a button click carries none. */
type RefreshOptions = { url?: string; timeoutMs?: number };

export default app
  .defineState<State>({
    endpoint: "http://127.0.0.1:8787/forecast/oslo",
    city: "—",
    temperature: "—",
    summary: "—",
    status: "idle",
    requests: 0,
  })
  .onAction("refresh", ({ action, state, context }) => {
    const options = (action.payload ?? {}) as RefreshOptions;
    state.requests += 1;
    state.status = "loading…";
    try {
      // Queued, not sent: this returns immediately. `tag` comes back with
      // the response, so a late answer to an older click can be told apart.
      context.http!.get(options.url ?? state.endpoint, {
        then: "loaded",
        tag: String(state.requests),
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      // Refused before anything was queued: no `http` grant, a host outside
      // `httpHosts`, a malformed URL. The message says which field to change.
      if (!isModuleHttpError(err)) throw err;
      state.status = `not sent (${err.code}): ${err.detail}`;
    }
  })
  .onAction("loaded", ({ action, state }) => {
    const response = action.payload;
    if (!isHttpCompletion(response)) return;
    // Only the newest request decides what is shown.
    if (response.tag !== String(state.requests)) return;
    if (!response.ok) {
      // No response at all: network, timeout, denied, too-large, invalid-response.
      state.status = `failed (${response.error.kind}): ${response.error.message}`;
      return;
    }
    if (response.status !== 200) {
      // A 404 or a 500 is a completed exchange; what it means is ours to say.
      state.status = `the server answered HTTP ${response.status}`;
      return;
    }
    const forecast = JSON.parse(response.body) as Forecast;
    state.city = forecast.city;
    state.temperature = `${forecast.tempC} °C`;
    state.summary = forecast.summary;
    state.status = "ok";
  })
  .build();
