/**
 * The DOM renderer routes UI events through the internal `__hypen_dispatch`
 * action (`{ node, action, payload }`). The action log shows the user's
 * action name and payload instead of that envelope.
 */
export function actionLogEntry(name: string, payload: unknown): { name: string; payload?: unknown } {
  const env = payload as { action?: unknown; payload?: unknown } | null;
  if (name === "__hypen_dispatch" && env && typeof env.action === "string") {
    return { name: env.action, payload: env.payload };
  }
  return { name, payload };
}
