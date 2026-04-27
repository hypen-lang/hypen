/**
 * Studio-hosted RemoteServer.
 *
 * Runs a single server-side Hypen engine inside the studio-ui process and
 * exposes it as a RemoteEngine endpoint at `/ws/engine`. Every client —
 * web DOM/Canvas cells in Test Mode, the iOS/Android runner apps, anyone
 * dialing the URL directly — speaks the same protocol and sees the same
 * scene. State stays convergent across clients via `.syncActions()`: each
 * action is replayed on every session's engine, so a tap on the web cell
 * updates the native mirror too (assuming deterministic handlers).
 *
 * On source file changes, `reload()` → `remoteServer.reload()` which uses
 * the engine's reconciler to emit minimal patches instead of tearing down
 * the tree. `reset()` is the escape hatch for when state gets wedged:
 * closes every live session so clients reconnect into a clean engine.
 *
 * When the entry .hypen has no sibling .ts module, we synthesise a mock
 * module from `@{state.*}` / `@actions.*` references in the template so
 * template-only projects still preview. The mock shape is editable via
 * `/api/engine/mock/*` routes → Studio's State panel → live state updates.
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type { ServerWebSocket } from "bun";
import { RemoteServer } from "@hypen-space/server/remote";
import {
  discoverComponents,
  loadDiscoveredComponents,
} from "@hypen-space/server";
import { app, configureLogger } from "@hypen-space/core";
import {
  scanReferences,
  buildShape,
  addArrayRow,
  findArrayPaths,
  type TemplateReferences,
} from "./mock-state.ts";

interface EngineTransport {
  send: (msg: unknown) => void;
  close: (code?: number, reason?: string) => void;
}

interface StudioEngineHostOptions {
  projectDir: string;
  componentsDir: string;
  entryName: string;
}

interface WsSessionHandle {
  session: any;
  receive: (raw: any) => void;
  destroy: () => void;
}

/**
 * Mocked state bookkeeping. When the user has no .ts for their entry,
 * we derive a schema from the template, hand the engine a generated
 * module, and remember the latest values here so Studio can GET + PUT
 * them via the /api/engine/mock routes.
 */
interface MockBinding {
  moduleName: string;
  state: Record<string, unknown>;
  refs: TemplateReferences;
  /** Primary module of the synthesised app — passed back to RemoteServer. */
  module: any;
}

export class StudioEngineHost {
  private readonly options: StudioEngineHostOptions;
  private remoteServer: RemoteServer | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readonly sessions = new WeakMap<ServerWebSocket<any>, WsSessionHandle>();
  // Live sessions keyed by transport so we can iterate on state-push.
  // WeakMap would drop entries the GC likes, but we only hold references
  // for the socket lifetime and clean up in onClose, so a Set is fine.
  private readonly liveSessions = new Set<any>();
  private readonly pendingSockets: ServerWebSocket<any>[] = [];

  private mock: MockBinding | null = null;

  constructor(options: StudioEngineHostOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.bootstrap();
    return this.readyPromise;
  }

  private async bootstrap(): Promise<void> {
    const candidates = [
      this.options.componentsDir,
      "src/components",
      "components",
    ];
    let componentsAbs: string | null = null;
    for (const rel of candidates) {
      const abs = resolve(this.options.projectDir, rel);
      if (existsSync(abs)) { componentsAbs = abs; break; }
    }
    if (!componentsAbs) {
      console.warn(
        `  [engine] no components directory found — tried: ${candidates.join(", ")}. ` +
          `Studio will render nothing until one exists.`
      );
      return;
    }

    const discovered = await discoverComponents(componentsAbs);
    const loaded = await loadDiscoveredComponents(discovered);
    const entry = loaded.get(this.options.entryName);

    if (!entry) {
      console.warn(
        `  [engine] entry "${this.options.entryName}" not found in ${componentsAbs} — ` +
          `studio will render nothing until the file is created.`
      );
      return;
    }

    let moduleForEngine: any;
    if (entry.module) {
      moduleForEngine = entry.module;
    } else {
      this.mock = this.synthesiseMock(entry.template ?? "");
      moduleForEngine = this.mock.module;
      const { statePaths, actionNames } = this.mock.refs;
      console.log(
        `  [engine] no module for "${this.options.entryName}" — using mock ` +
          `(${statePaths.length} state path${statePaths.length === 1 ? "" : "s"}, ` +
          `${actionNames.length} action${actionNames.length === 1 ? "" : "s"}).`
      );
    }

    configureLogger({ level: "error" });

    this.remoteServer = new RemoteServer()
      .module(this.options.entryName, moduleForEngine)
      .source(componentsAbs)
      .syncActions()
      .onSessionCreate((session: any) => {
        // Track sessions so mock-state pushes can reach every engine.
        this.liveSessions.add(session);
      });

    await this.remoteServer.prepare();
    this.ready = true;

    for (const ws of this.pendingSockets.splice(0)) {
      this.attachSession(ws);
    }
  }

  private synthesiseMock(template: string): MockBinding {
    const refs = scanReferences(template);
    const state = buildShape(refs.statePaths);
    const moduleName = this.options.entryName;

    // Build the module with the derived shape + no-op action handlers.
    // `.onAction` requires a handler to swallow the dispatch; the panel can
    // echo these into the Studio console via /api/engine/mock/action if the
    // user wants to simulate a dispatch.
    let builder: any = app.defineState(state);
    for (const name of refs.actionNames) {
      builder = builder.onAction(name, async () => { /* no-op mock */ });
    }
    const module = builder.build();

    return { moduleName, state, refs, module };
  }

  /** Push the current mock state into every live engine. */
  private pushMockState(): void {
    if (!this.mock) return;
    const next = this.mock.state;
    for (const session of this.liveSessions) {
      try {
        // Primary module scope — empty string targets the top-level slot.
        session.engine.updateState("", next);
      } catch (err: any) {
        console.warn("[engine] pushMockState failed for a session:", err?.message ?? err);
      }
    }
  }

  attachSession(ws: ServerWebSocket<any>): void {
    if (!this.ready || !this.remoteServer) {
      this.pendingSockets.push(ws);
      return;
    }

    const transport: EngineTransport = {
      send: (msg) => {
        try { ws.send(JSON.stringify(msg)); } catch { /* socket closed */ }
      },
      close: (code, reason) => {
        try { ws.close(code, reason); } catch { /* already closed */ }
      },
    };

    const session = this.remoteServer.createSession(transport, { socketHandle: ws });

    // If we're in mock mode, seed the newly-connected session with our
    // last-known state so a late-joiner sees what the earlier clients see.
    if (this.mock) {
      try { session.engine.updateState("", this.mock.state); } catch { /* engine not yet ready */ }
    }

    this.sessions.set(ws, {
      session,
      receive: (raw) => {
        session.receive(raw).catch((err: any) =>
          console.warn("[engine] session.receive failed:", err?.message ?? err)
        );
      },
      destroy: () => {
        this.liveSessions.delete(session);
        session.destroy().catch(() => { /* already destroyed */ });
      },
    });
  }

  onMessage(ws: ServerWebSocket<any>, raw: string | Buffer): void {
    const handle = this.sessions.get(ws);
    if (handle) handle.receive(raw);
  }

  onClose(ws: ServerWebSocket<any>): void {
    const handle = this.sessions.get(ws);
    if (!handle) {
      const idx = this.pendingSockets.indexOf(ws);
      if (idx >= 0) this.pendingSockets.splice(idx, 1);
      return;
    }
    handle.destroy();
    this.sessions.delete(ws);
  }

  async reload(): Promise<void> {
    if (!this.remoteServer) return;
    // If we're in mock mode, re-scan the template in case the user added or
    // removed `@{state.*}` references; merge new paths into existing state
    // so previously-edited values survive the re-render.
    if (this.mock) {
      try { await this.rescanMockFromSource(); } catch { /* keep going */ }
    }
    try {
      await this.remoteServer.reload();
      // Re-push because `reload()` re-renders but won't reset state to the
      // mock's current values — especially important when new paths were
      // just added.
      this.pushMockState();
    } catch (err: any) {
      console.warn("[engine] reload failed:", err?.message ?? err);
    }
  }

  private async rescanMockFromSource(): Promise<void> {
    if (!this.mock) return;
    const candidates = [
      this.options.componentsDir,
      "src/components",
      "components",
    ];
    let componentsAbs: string | null = null;
    for (const rel of candidates) {
      const abs = resolve(this.options.projectDir, rel);
      if (existsSync(abs)) { componentsAbs = abs; break; }
    }
    if (!componentsAbs) return;
    const discovered = await discoverComponents(componentsAbs);
    const entry = discovered.find((d) => d.name === this.options.entryName);
    if (!entry?.template) return;

    const refs = scanReferences(entry.template);
    const nextShape = buildShape(refs.statePaths);
    this.mock.refs = refs;
    this.mock.state = mergePreservingExisting(nextShape, this.mock.state);
  }

  reset(): void {
    if (!this.remoteServer) return;
    // If mocked, reset to the derived-default state rather than tearing
    // down the socket — the user wants "start over", not "redial".
    if (this.mock) {
      this.mock.state = buildShape(this.mock.refs.statePaths);
      this.pushMockState();
      return;
    }
    this.remoteServer.broadcast({ type: "server-reset" } as any);
  }

  // ─── Mock-state API surface — called from /api/engine/mock/* ───

  getMockState(): {
    active: boolean;
    state: Record<string, unknown>;
    refs: TemplateReferences;
    arrayPaths: string[];
  } {
    if (!this.mock) {
      return { active: false, state: {}, refs: { statePaths: [], actionNames: [] }, arrayPaths: [] };
    }
    return {
      active: true,
      state: this.mock.state,
      refs: this.mock.refs,
      arrayPaths: findArrayPaths(this.mock.state),
    };
  }

  setMockState(next: Record<string, unknown>): void {
    if (!this.mock) return;
    this.mock.state = next;
    this.pushMockState();
  }

  addMockArrayRow(path: string): void {
    if (!this.mock) return;
    addArrayRow(this.mock.state, path);
    this.pushMockState();
  }

  fireMockAction(name: string, payload?: unknown): void {
    if (!this.mock) return;
    for (const session of this.liveSessions) {
      try { session.engine.dispatchAction(name, payload); } catch { /* swallow */ }
      break; // syncActions replicates to the rest; one dispatch is enough.
    }
  }

  isReady(): boolean {
    return this.ready;
  }
}

/** Merge `next` into `prev`, keeping `prev`'s values where the path exists. */
function mergePreservingExisting(next: any, prev: any): any {
  if (Array.isArray(next)) {
    // Arrays: if the user had rows, keep them; otherwise take the new default.
    return Array.isArray(prev) && prev.length > 0 ? prev : next;
  }
  if (next && typeof next === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      out[k] = prev && typeof prev === "object" && k in prev
        ? mergePreservingExisting(v, (prev as any)[k])
        : v;
    }
    return out;
  }
  // Scalar: prefer the user's existing value if they had one.
  return prev !== undefined ? prev : next;
}
