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
 * effect, which the host performs.
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

export function createModuleExports(def: ModuleDefinitionLike, host: EngineStateImports): ModuleExports {
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
