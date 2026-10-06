/** Renderer-only dispatch. Ownership is resolved from the live engine tree;
 * user payload fields cannot select a module. Unknown protocol entry points
 * are inert on older engines. */
export function dispatchUIAction(
  engine: { dispatchAction(name: string, payload?: any): void },
  node: string | undefined,
  action: string,
  payload?: unknown,
  fromNode?: string,
): void {
  if (!node) {
    // Programmatic/synthetic controls retain single-owner legacy dispatch.
    engine.dispatchAction(action, payload);
    return;
  }
  engine.dispatchAction("__hypen_dispatch", { node, action, payload, ...(fromNode ? { fromNode } : {}) });
}
