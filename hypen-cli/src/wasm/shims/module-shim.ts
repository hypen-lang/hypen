/**
 * The TypeScript module shim: adapts a Hypen module definition (the default
 * export of a module file, built with `app.defineState().onAction().build()`)
 * to the `hypen:module` reducer ABI.
 *
 * This file is bundled *into the user's component* — it runs inside the wasm
 * guest (StarlingMonkey), not in the CLI. The CLI generates a three-line
 * entry per module (`tsShimEntrySource`) that imports the user's module and
 * the host's `hypen:engine/state` capability and passes both to
 * `createModuleExports`. So it must stay self-contained: no imports, no Node
 * or Bun APIs, only what a bare JS engine provides.
 *
 * Reducer semantics mirror `@hypen-space/core`: handlers mutate `state` in
 * place and the mutated object is serialised back. Cross-module writes,
 * unsubscribe, router reads/history, data sources and async handlers are not
 * bridged across the wasm boundary yet and fail loudly rather than silently
 * misbehaving. `router.push` / `replace` / `navigate` emit the WIT `navigate`
 * effect, which the host performs. `context.http` queues requests through
 * `hypen:http/deferred` (when the module is granted `http`): the host
 * performs them after the reducer returns and dispatches the named action
 * with the response.
 */

// ── The WIT surface, as componentize-js presents it to JS ────────────────────

/** `types.json`: UTF-8 JSON bytes. */
export type JsonBytes = Uint8Array;

/** `types.action`. */
export interface WitAction {
  name: string;
  payload: JsonBytes;
}

/** `types.effect`, as a componentize-js variant (`{ tag, val }`). */
export type WitEffect =
  | { tag: "navigate"; val: string }
  | { tag: "delay"; val: { ms: number; then: string } }
  | { tag: "log"; val: { level: "trace" | "debug" | "info" | "warn" | "error"; message: string } };

/** `types.reducer-output`. `state: undefined` is WIT `none` (no change). */
export interface ReducerOutput {
  state: JsonBytes | undefined;
  effects: WitEffect[];
  emit: WitAction[];
}

/**
 * The `hypen:engine/state` functions the shim imports. componentize-js turns
 * a WIT `err(e)` into a thrown `ComponentError` whose `payload` is the
 * variant (`{ tag: "not-found" }`, `{ tag: "permission-denied", val }`, …).
 */
export interface EngineStateImports {
  read(module: string): JsonBytes;
  subscribe(module: string, path: string, onChange: string): void;
}

/** The WIT `request` record of `hypen:http/deferred`, as componentize-js takes it. */
export interface WitHttpRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** `undefined` is WIT `none`. */
  body: Uint8Array | undefined;
  timeoutMs: number | undefined;
}

/**
 * The `hypen:http/deferred` function the shim imports — only in a module
 * built with the `http` grant (the import is not in an ungranted module's
 * world at all). A WIT `err(e)` is thrown as a `ComponentError` whose
 * `payload` is the variant: `{ tag: "permission-denied" | "invalid-request" |
 * "limit-exceeded", val: string }`.
 */
export interface DeferredHttpImports {
  send(request: WitHttpRequest, then: string, tag: string | undefined): void;
}

/** What differs per module besides its definition. */
export interface ShimOptions {
  /** The module's name as declared (`Weather`), for error messages. */
  name?: string;
  /** The host's `hypen:http/deferred`, when the module is granted `http`. */
  http?: DeferredHttpImports;
}

/** The world's exports. A `result<T, string>` export returns `T` or throws a string. */
export interface ModuleExports {
  init(config: JsonBytes): JsonBytes;
  dispatch(state: JsonBytes, action: WitAction): ReducerOutput;
  onActivated(state: JsonBytes): ReducerOutput;
  onDeactivated(state: JsonBytes): ReducerOutput;
  onDestroyed(state: JsonBytes): void;
  actions(): string[];
}

// ── The module definition, as far as the shim relies on it ───────────────────

/** A module's state object, decoded from JSON. */
export type ShimState = Record<string, unknown>;

/** The `context.router` surface available on the wasm target. */
export interface ShimRouter {
  push(path: string): void;
  replace(path: string): void;
  navigate(path: string): void;
}

/** A request for `context.http.send`. */
export interface ShimHttpRequest {
  /** Default: `"GET"`, or `"POST"` when there is a `body`. */
  method?: string;
  /** Absolute `http://` or `https://` URL. */
  url: string;
  /** A plain object or `[name, value]` pairs. */
  headers?: Record<string, string> | ReadonlyArray<readonly [string, string]>;
  /**
   * A string (sent as UTF-8; `content-type: text/plain;charset=UTF-8` unless
   * set), bytes (sent as they are), or any other JSON-serialisable value
   * (sent as JSON; `content-type: application/json` unless set).
   */
  body?: unknown;
  /** Time budget for the whole exchange, in milliseconds (default 30 s, capped at 120 s). */
  timeoutMs?: number;
}

/** Where a request's completion goes. */
export interface ShimHttpCompletionTarget {
  /** The action of THIS module dispatched with the `HttpCompletion` as its payload. */
  then: string;
  /** Echoed back as `payload.tag`, so one handler can tell requests apart. */
  tag?: string;
}

/**
 * Why `context.http.send` refused: the WIT `error` variant's case, or
 * `"not-granted"` when the module was built without the `http` grant.
 */
export type ShimHttpErrorCode = "not-granted" | "permission-denied" | "invalid-request" | "limit-exceeded";

/**
 * What `context.http.send` / `get` throw. An `Error` (so an uncaught one
 * reaches the host as the handler's failure message) with a stable `code`;
 * recognise it by `name === "ModuleHttpError"` — the class itself lives in
 * the guest and cannot be imported by a module.
 */
export class ModuleHttpError extends Error {
  readonly code: ShimHttpErrorCode;
  /** The host's own message, without the hint. */
  readonly detail: string;

  constructor(code: ShimHttpErrorCode, message: string, detail: string) {
    super(message);
    this.name = "ModuleHttpError";
    this.code = code;
    this.detail = detail;
  }
}

/** `context.http` on the wasm target: outbound HTTP for a synchronous reducer. */
export interface ShimHttp {
  /**
   * Queue `request`. Returns at once — nothing has been sent yet. When the
   * exchange completes or fails, the host dispatches the action `on.then` to
   * this module with the completion (`{ ok: true, status, headers, body,
   * bodyEncoding, tag }` or `{ ok: false, error: { kind, message }, tag }`)
   * as its payload.
   *
   * @throws {ModuleHttpError} when the request is refused: no `http` grant,
   *   a host outside `httpHosts`, a malformed request, or a bound exceeded.
   */
  send(request: ShimHttpRequest, on: ShimHttpCompletionTarget): void;
  /** `send({ method: "GET", url, … }, on)`. */
  get(url: string, on: ShimHttpCompletionTarget & Pick<ShimHttpRequest, "headers" | "timeoutMs">): void;
}

/** The `GlobalContext` handlers receive on the wasm target. */
export interface ShimContext {
  getModule(id: string): {
    readonly state: unknown;
    getState(): unknown;
    setState(): never;
  };
  hasModule(id: string): boolean;
  getModuleIds(): string[];
  getGlobalState(): Record<string, unknown>;
  emit(name: string, payload?: unknown): void;
  on(module: string, path: string | undefined, onChange: string): () => never;
  router: ShimRouter;
  http: ShimHttp;
}

export interface ShimActionContext {
  action: { name: string; payload: unknown; sender: undefined };
  state: ShimState;
  context: ShimContext;
  dataSources: Record<string, never>;
}

/**
 * Handlers are typed as returning `unknown`: the SDK's handler types allow a
 * Promise, and the shim must be able to detect one to reject it (`assertSync`).
 */
export type ShimActionHandler = (ctx: ShimActionContext) => unknown;
export type ShimLifecycleHandler = (state: ShimState, context: ShimContext) => unknown;

/** The fields of `HypenModuleDefinition` the shim reads. */
export interface ModuleDefinitionLike {
  initialState: unknown;
  actions: string[];
  handlers: {
    onAction: ReadonlyMap<string, ShimActionHandler>;
    onActivated?: ShimLifecycleHandler;
    onDeactivated?: ShimLifecycleHandler;
    onDestroyed?: ShimLifecycleHandler;
  };
}

// ── Implementation ───────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A decoded JSON value usable as a state object (`{}` when it is not one). */
const asState = (v: unknown): ShimState => (isObject(v) ? v : {});

/**
 * The tag of a `hypen:engine/state` `error` variant thrown by an import
 * (componentize-js throws a ComponentError carrying the variant as `payload`).
 */
function stateErrorTag(e: unknown): unknown {
  const variant = isObject(e) && "payload" in e ? e.payload : e;
  return isObject(variant) ? variant.tag : undefined;
}

/**
 * componentize-js turns a thrown *string* into the export's `err(string)`,
 * but re-throws an Error instance — a trap that kills the instance and loses
 * the message. Every result-returning export goes through `guard` so the
 * loud failures in this file reach the host as readable module errors.
 */
function guard<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      if (isObject(e) && Object.prototype.hasOwnProperty.call(e, "payload")) {
        throw "host capability error: " + JSON.stringify(e.payload);
      }
      throw e instanceof Error ? e.message || String(e) : typeof e === "string" ? e : JSON.stringify(e);
    }
  };
}

function assertSync(ret: unknown, what: string): void {
  if (isObject(ret) && typeof ret.then === "function") {
    // Swallow the eventual rejection; the error below is the one to surface.
    if (typeof ret.catch === "function") ret.catch(() => {});
    throw new Error(
      "async handlers are not supported on the wasm target yet (" + what + " returned a Promise)"
    );
  }
}

const HTTP_ERROR_CODES: readonly ShimHttpErrorCode[] = ["permission-denied", "invalid-request", "limit-exceeded"];

export function createModuleExports(
  def: ModuleDefinitionLike,
  host: EngineStateImports,
  options: ShimOptions = {}
): ModuleExports {
  const moduleName = options.name || "<Name>";
  const httpImport = options.http;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const encJson = (v: unknown): JsonBytes => enc.encode(JSON.stringify(v ?? null));
  const decJson = (b: JsonBytes | undefined): unknown =>
    b && b.length ? (JSON.parse(dec.decode(b)) as unknown) : null;

  // Snapshot a sibling module's current state via the engine's synchronous
  // cross-module read. Requires the target in this module's manifest `reads`
  // (the host throws otherwise). Valid only while a reducer/lifecycle call is
  // on the stack — the host installs the sibling snapshots per-call.
  const readSiblingState = (id: string): unknown => decJson(host.read(id));

  // Navigation maps to the WIT `navigate` effect (the host performs it after
  // the reducer returns); everything that would need the host's live route
  // state or history is not wired yet and fails loudly.
  const routerFor = (effects: WitEffect[]): ShimRouter => {
    const navigate = (path: string): void => {
      if (typeof path !== "string") {
        throw new Error("router navigation needs a path string on the wasm target");
      }
      effects.push({ tag: "navigate", val: path });
    };
    const wired: ShimRouter = { push: navigate, replace: navigate, navigate };
    return new Proxy(wired, {
      get(target, prop, receiver) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (prop === "then") return undefined; // not a thenable
        throw new Error(
          "context.router." +
            prop +
            " is not supported on the wasm target yet: only push/replace/navigate (the host's navigate effect) are wired"
        );
      },
    });
  };

  // `context.http`: a request is only *queued* here (hypen:http/deferred);
  // the host performs it after this call returns and dispatches `on.then`
  // with the completion. Everything the host would refuse anyway is still
  // sent to it — it owns the rules — except what only the shim can know:
  // that the module has no grant, and what its own actions are.
  const invalidRequest = (what: string): ModuleHttpError =>
    new ModuleHttpError("invalid-request", "context.http.send: " + what, what);

  const httpHeaders = (headers: ShimHttpRequest["headers"]): Array<[string, string]> => {
    if (headers === undefined || headers === null) return [];
    const pairs: ReadonlyArray<readonly [unknown, unknown]> = Array.isArray(headers)
      ? headers
      : isObject(headers)
        ? Object.entries(headers)
        : (() => {
            throw invalidRequest("`headers` must be an object or a list of [name, value] pairs");
          })();
    return pairs.map((pair) => {
      const [name, value] = Array.isArray(pair) ? pair : [];
      if (typeof name !== "string" || typeof value !== "string") {
        throw invalidRequest("every header needs a string name and a string value");
      }
      return [name, value];
    });
  };

  const hasHeader = (headers: Array<[string, string]>, name: string): boolean =>
    headers.some(([n]) => n.toLowerCase() === name);

  const sendHttp = (request: ShimHttpRequest, on: ShimHttpCompletionTarget): void => {
    if (!httpImport) {
      const detail = "this module has no `http` grant";
      throw new ModuleHttpError(
        "not-granted",
        "context.http: " + detail + ' — add "http": true under wasm.modules.' + moduleName + " in hypen.json",
        detail
      );
    }
    if (!isObject(request) || typeof request.url !== "string") {
      throw invalidRequest("the request needs a `url` string");
    }
    if (!isObject(on) || typeof on.then !== "string" || on.then === "") {
      throw invalidRequest(
        '`then` is missing: name the action that receives the response, e.g. { then: "loaded" }'
      );
    }
    if (!def.actions.includes(on.then) && !def.actions.includes("*")) {
      throw invalidRequest(
        '`then: "' +
          on.then +
          '"` is not an action of this module (it handles: ' +
          (def.actions.join(", ") || "none") +
          ') — add .onAction("' +
          on.then +
          '", …) to receive the response'
      );
    }
    if (on.tag !== undefined && typeof on.tag !== "string") throw invalidRequest("`tag` must be a string");
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0)) {
      throw invalidRequest("`timeoutMs` must be a whole number of milliseconds");
    }
    if (request.method !== undefined && typeof request.method !== "string") {
      throw invalidRequest("`method` must be a string");
    }

    const headers = httpHeaders(request.headers);
    let body: Uint8Array | undefined;
    const given = request.body;
    if (given instanceof Uint8Array) {
      body = given;
    } else if (typeof given === "string") {
      body = enc.encode(given);
      if (!hasHeader(headers, "content-type")) headers.push(["content-type", "text/plain;charset=UTF-8"]);
    } else if (given !== undefined && given !== null) {
      let json: string | undefined;
      try {
        json = JSON.stringify(given);
      } catch (e) {
        throw invalidRequest("`body` is not JSON-serialisable: " + (e instanceof Error ? e.message : String(e)));
      }
      if (json === undefined) throw invalidRequest("`body` is not JSON-serialisable");
      body = enc.encode(json);
      if (!hasHeader(headers, "content-type")) headers.push(["content-type", "application/json"]);
    }

    try {
      httpImport.send(
        {
          method: request.method ?? (body === undefined ? "GET" : "POST"),
          url: request.url,
          headers,
          body,
          timeoutMs: request.timeoutMs,
        },
        on.then,
        on.tag
      );
    } catch (e) {
      const variant = isObject(e) && "payload" in e ? e.payload : e;
      const tag = isObject(variant) ? variant.tag : undefined;
      const code = HTTP_ERROR_CODES.find((c) => c === tag);
      if (code === undefined) throw e;
      const detail = isObject(variant) && typeof variant.val === "string" ? variant.val : code;
      const hint =
        code === "permission-denied" && detail.includes("httpHosts")
          ? " — add the host to wasm.modules." + moduleName + ".httpHosts in hypen.json"
          : "";
      throw new ModuleHttpError(code, "context.http.send: " + code + ": " + detail + hint, detail);
    }
  };

  const http: ShimHttp = {
    send: sendHttp,
    get: (url, on) =>
      sendHttp(
        { method: "GET", url, headers: isObject(on) ? on.headers : undefined, timeoutMs: isObject(on) ? on.timeoutMs : undefined },
        on
      ),
  };

  // The wasm-target GlobalContext. Sync surfaces (read/emit/subscribe) are
  // wired to the engine; async cross-module *writes* fail loudly. `emit` is
  // the current call's ReducerOutput.emit accumulator, `effects` its effects.
  const contextFor = (emit: WitAction[], effects: WitEffect[]): ShimContext => ({
    getModule: (id) => ({
      get state() {
        return readSiblingState(id);
      },
      getState: () => readSiblingState(id),
      setState() {
        throw new Error(
          "context.getModule(...).setState is not supported on the wasm target yet (cross-module writes need directed dispatch)"
        );
      },
    }),
    // Absent (not-found) is `false`; a sibling that exists but isn't granted
    // is an error, not an absence — the fix is a manifest grant.
    hasModule: (id) => {
      try {
        host.read(id);
        return true;
      } catch (e) {
        const tag = stateErrorTag(e);
        if (tag === "not-found") return false;
        if (tag === "permission-denied") {
          throw new Error(
            'context.hasModule("' +
              id +
              '"): permission denied (the host only reports on modules listed in the reads grant) — add it to wasm.modules.<ThisModule>.reads in hypen.json'
          );
        }
        throw e;
      }
    },
    // Siblings can't be enumerated across the wasm boundary.
    getModuleIds: () => [],
    // Lazy global view: `globalState[moduleId]` reads that sibling on access.
    getGlobalState: () =>
      new Proxy<Record<string, unknown>>(
        {},
        { get: (_target, id) => (typeof id === "string" ? readSiblingState(id) : undefined) }
      ),
    // Enqueue a follow-up action on this module; the engine dispatches it
    // after the current reducer returns (ReducerOutput.emit).
    emit: (name, payload) => {
      emit.push({ name, payload: encJson(payload) });
    },
    // Observe a sibling: re-dispatch `onChange` (an action name) whenever
    // `module`'s state changes at dotted `path`. Maps 1:1 to
    // hypen:engine/state.subscribe. The WIT has no unsubscribe (subscriptions
    // end when the module is torn down), so the returned function fails
    // loudly instead of pretending to unsubscribe.
    on: (module, path, onChange) => {
      host.subscribe(module, path ?? "", onChange);
      return () => {
        throw new Error(
          "unsubscribing from context.on(...) is not supported on the wasm target (subscriptions last until the module is torn down)"
        );
      };
    },
    router: routerFor(effects),
    http,
  });

  const dataSources = new Proxy<Record<string, never>>(
    {},
    {
      get() {
        throw new Error("data sources are not supported on the wasm target yet");
      },
    }
  );

  const lifecycle = (fn: ShimLifecycleHandler | undefined, name: string) =>
    guard((stateBytes: JsonBytes): ReducerOutput => {
      if (!fn) return { state: undefined, effects: [], emit: [] };
      const state = asState(decJson(stateBytes));
      const emit: WitAction[] = [];
      const effects: WitEffect[] = [];
      assertSync(fn(state, contextFor(emit, effects)), name);
      return { state: encJson(state), effects, emit };
    });

  return {
    init: guard((config) => {
      // Declaration-site config (`module X(start: 5)` → {"start":5})
      // shallow-merges over the static initialState. No config (empty /
      // non-object) leaves the initialState untouched.
      const seed = decJson(config);
      if (!isObject(seed) || Array.isArray(seed) || Object.keys(seed).length === 0) {
        return encJson(def.initialState);
      }
      return encJson({ ...(isObject(def.initialState) ? def.initialState : {}), ...seed });
    }),

    dispatch: guard((stateBytes, action) => {
      const state = asState(decJson(stateBytes));
      const handler = def.handlers.onAction.get(action.name);
      if (!handler) throw new Error("unknown action: " + action.name);
      const emit: WitAction[] = [];
      const effects: WitEffect[] = [];
      const ret = handler({
        action: { name: action.name, payload: decJson(action.payload), sender: undefined },
        state,
        context: contextFor(emit, effects),
        dataSources,
      });
      assertSync(ret, 'action handler "' + action.name + '"');
      return { state: encJson(state), effects, emit };
    }),

    onActivated: lifecycle(def.handlers.onActivated, "onActivated"),
    onDeactivated: lifecycle(def.handlers.onDeactivated, "onDeactivated"),

    onDestroyed: guard((stateBytes) => {
      // on-destroyed returns result<_, string> (no reducer-output), so any
      // emit()/on()/navigation here is dropped — matching the native host,
      // which discards them.
      const { onDestroyed } = def.handlers;
      if (onDestroyed) {
        assertSync(onDestroyed(asState(decJson(stateBytes)), contextFor([], [])), "onDestroyed");
      }
    }),

    actions: () => def.actions,
  };
}
