/**
 * Core types shared across the engine and runtime.
 *
 * These types are intentionally decoupled from the WASM engine so that
 * packages can import them without pulling in any WASM code.
 */

export type Patch = {
  /**
   * Patch variant.
   *
   * `detach` / `attach` are used by the engine's Router subtree cache
   * to keep off-screen route content alive between navigations. On
   * `detach`, the renderer must unlink the subtree from its parent
   * but keep the underlying native element (and its children) alive
   * under the same id, so a later `attach` can reinsert it with zero
   * rebuild. If `remove` arrives for a detached id instead, the
   * subtree is torn down normally.
   */
  type:
    | "create"
    | "setProp"
    | "removeProp"
    | "setText"
    | "insert"
    | "move"
    | "remove"
    | "attachEvent"
    | "detachEvent"
    | "detach"
    | "attach";
  id?: string;
  elementType?: string;
  props?: Record<string, any>;
  name?: string;
  value?: any;
  text?: string;
  parentId?: string;
  beforeId?: string;
  eventName?: string;
};

export type Action = {
  name: string;
  payload?: any;
  sender?: string;
};

export type RenderCallback = (patches: Patch[]) => void;
export type ActionHandler = (action: Action) => void | Promise<void>;

export type ResolvedComponent = {
  source: string;
  path: string;
};

export type ComponentResolver = (
  componentName: string,
  contextPath: string | null
) => ResolvedComponent | null;

