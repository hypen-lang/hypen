/**
 * Shared harness for the hosted-module server tests: a `RemoteServer` with
 * TypeScript modules and hosted (WASM-component) modules side by side,
 * driven through real `RemoteSession`s over an in-memory transport — the
 * same message path a WebSocket client uses.
 *
 * Components are the committed fixtures of hypen-engine-rs/tests/fixtures
 * (see its README for what each one does).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RemoteServer } from "../packages/server/src/remote/server";
import type { RemoteSession } from "../packages/server/src/remote/session";
import type { OutgoingMessage, SessionTransport } from "../packages/server/src/remote/session";
import type { HostedModuleFailure } from "../packages/core/src/hosted-module";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const FIXTURES = resolve(REPO_ROOT, "hypen-engine-rs", "tests", "fixtures");
export const fixture = (file: string): string => resolve(FIXTURES, file);
export const hasFixtures = (...files: string[]): boolean => files.every((f) => existsSync(fixture(f)));
export const hasServerEngine = existsSync(
  resolve(REPO_ROOT, "hypen-web", "packages", "server", "wasm-node", "hypen_engine.js")
);

export const flush = (ms = 15): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait until `check` stops throwing (or returns), for at most `timeout` ms. */
export async function eventually<T>(check: () => T, timeout = 2000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await flush(10);
    }
  }
}

type AnyPatch = Record<string, any>;

/** One connected client: everything the server sent it, and helpers to act like a renderer. */
export interface Client {
  session: RemoteSession;
  sent: OutgoingMessage[];
  /** Every patch received so far (initial tree + streamed). */
  patches(): AnyPatch[];
  /** Every string prop value currently known for created nodes, in arrival order. */
  texts(): string[];
  /** Wire id of the created node whose props contain `needle`. */
  node(needle: string): string;
  /** Wire id of the Button whose accessible name is `label`. */
  button(label: string): string;
  /** Click: the `__hypen_dispatch` envelope a renderer sends for a UI event. */
  click(node: string, action: string, payload?: unknown): Promise<void>;
  /** Send a raw `dispatchAction` message. */
  send(action: string, payload?: unknown): Promise<void>;
  /** State of the module registered under `id` (hosted or TypeScript), via the session's global context. */
  state<T = Record<string, any>>(id: string): T;
  close(): Promise<void>;
}

export async function connect(
  server: RemoteServer,
  hello: { sessionId?: string; props?: Record<string, unknown> } = {}
): Promise<Client> {
  const sent: OutgoingMessage[] = [];
  const transport: SessionTransport = { send: (m) => sent.push(m), close: () => {} };
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello", ...hello } as never);
  await session.ready;
  await flush();

  const patches = (): AnyPatch[] =>
    sent.flatMap((m) => (m.type === "initialTree" || m.type === "patch" ? (m.patches as AnyPatch[]) : []));
  const client: Client = {
    session,
    sent,
    patches,
    texts() {
      // Latest text per node, in creation order.
      const byNode = new Map<string, string[]>();
      for (const p of patches()) {
        if (p.type === "create") {
          byNode.set(p.id, Object.values(p.props ?? {}).filter((v): v is string => typeof v === "string"));
        } else if (p.type === "setProp" && typeof p.value === "string") {
          byNode.set(p.id, [p.value]);
        }
      }
      return [...byNode.values()].flat();
    },
    node(needle) {
      for (const p of patches()) {
        if (p.type === "create" && JSON.stringify(p.props ?? {}).includes(needle)) return p.id;
      }
      throw new Error(`no node carrying ${needle}`);
    },
    button(label) {
      for (const p of patches()) {
        if (p.type === "create" && p.elementType === "Button" && p.semantics?.name === label) return p.id;
      }
      throw new Error(`no Button named ${label}`);
    },
    async click(node, action, payload = {}) {
      await client.send("__hypen_dispatch", { node, action, payload });
    },
    async send(action, payload) {
      await session.receive({ type: "dispatchAction", module: "App", action, payload } as never);
      await flush();
    },
    state<T>(id: string): T {
      const context = (session as unknown as { _globalContext: { getModule(id: string): { getState(): T } } })
        ._globalContext;
      return context.getModule(id).getState();
    },
    async close() {
      await session.destroy();
    },
  };
  return client;
}

/** Collects the failures a server's `hostedModules({ onError })` reports. */
export function failureLog(): { failures: HostedModuleFailure[]; onError: (f: HostedModuleFailure) => void } {
  const failures: HostedModuleFailure[] = [];
  return { failures, onError: (f) => failures.push(f) };
}
