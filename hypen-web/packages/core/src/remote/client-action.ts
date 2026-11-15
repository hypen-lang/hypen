/**
 * Admission of actions received from a remote client.
 *
 * A Remote UI client is a thin renderer on someone else's device: whatever it
 * puts in a `dispatchAction` message is untrusted. `engine.dispatchAction`
 * is the same-trust-domain entry — it runs a registered
 * `__hypen_scoped:<scope>:<name>` as given, a bare name one module handles,
 * and a bare `__hypen_bind` to an arbitrary state path — so wire input never
 * goes to it directly. It goes through here first:
 *
 * - a `__hypen_dispatch` envelope is authorised by the engine's client entry
 *   (`resolveClientAction`): the addressed node must be live, attached, and
 *   itself declare the action (`.onClick(@actions.x)`, `.bind(...)` for the
 *   reserved writes);
 * - every other `__hypen_*` name (a pre-scoped name, a bare reserved write)
 *   is refused;
 * - a bare application name is refused unless the host listed it in
 *   {@link UnboundClientActions} — the escape hatch for actions a client
 *   legitimately sends with no node behind them (a `navigation.backAction`,
 *   a custom client's command). The four router actions are always admitted:
 *   navigation is bounded by the route table, and URL sync sends them.
 *
 * The result is a resolved action — trusted input for `engine.dispatchAction`
 * on this session's engine and, under `syncActions`, on its peers'.
 */

/** Bare action names a client may send with no node behind them. `"any"`
 * restores the earlier by-name behaviour for application names (any name exactly
 * one module handles); it never admits a `__hypen_*` name. */
export type UnboundClientActions = readonly string[] | "any";

export const UI_ACTION_ENVELOPE = "__hypen_dispatch";

const RESERVED_PREFIX = "__hypen_";
const SCOPED_PREFIX = "__hypen_scoped:";
const ROUTER_ACTIONS: ReadonlySet<string> = new Set([
  "router.push",
  "router.replace",
  "router.back",
  "router.forward",
]);

/** A client action the server will not run. Never reaches a handler. */
export class ClientActionRefused extends Error {
  constructor(
    readonly action: string,
    readonly reason: string,
  ) {
    super(`client action refused (${reason})`);
    this.name = "ClientActionRefused";
  }
}

export interface ClientActionEngine {
  /** False on a WASM artifact that predates the engine's client entry. */
  readonly hasClientActionEntry: boolean;
  resolveClientAction(name: string, payload?: unknown): { name: string; payload?: unknown };
  resolveUIAction(name: string, payload?: unknown): { name: string; payload?: unknown };
}

/**
 * Resolve an envelope through the strictest entry the engine has.
 *
 * On an artifact without `resolveClientAction` the envelope is still
 * resolved by node ownership (`resolveUIAction`), after the checks that can
 * be made here: the inner name must be an application action or one of the
 * three reserved writes (which the engine validates against the node's
 * `.bind` on either entry). The per-node binding check needs the rebuilt
 * engine.
 */
export function resolveClientEnvelope(
  engine: ClientActionEngine,
  payload: unknown,
): { name: string; payload?: unknown } {
  if (engine.hasClientActionEntry) {
    return engine.resolveClientAction(UI_ACTION_ENVELOPE, payload);
  }
  const inner = (payload as { action?: unknown } | null | undefined)?.action;
  if (typeof inner !== "string") {
    throw new ClientActionRefused(UI_ACTION_ENVELOPE, "malformed envelope");
  }
  if (
    inner.startsWith(RESERVED_PREFIX) &&
    inner !== "__hypen_bind" &&
    inner !== "__hypen_reorder" &&
    inner !== "__hypen_pin"
  ) {
    throw new ClientActionRefused(inner, "reserved name");
  }
  return engine.resolveUIAction(UI_ACTION_ENVELOPE, payload);
}

/**
 * Whether a non-envelope name from the wire may be dispatched as given.
 * Throws {@link ClientActionRefused} when it may not.
 */
export function admitUnboundClientAction(
  name: unknown,
  allowed: UnboundClientActions | undefined,
): asserts name is string {
  if (typeof name !== "string" || name === "") {
    throw new ClientActionRefused(String(name), "malformed action name");
  }
  if (name.startsWith(SCOPED_PREFIX)) {
    throw new ClientActionRefused(name, "pre-scoped name");
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new ClientActionRefused(name, "reserved name outside an envelope");
  }
  if (ROUTER_ACTIONS.has(name)) return;
  if (allowed === "any") return;
  if (allowed?.includes(name)) return;
  throw new ClientActionRefused(
    name,
    "not sent from a node that declares it; list it in `unboundClientActions` to accept it by name",
  );
}
