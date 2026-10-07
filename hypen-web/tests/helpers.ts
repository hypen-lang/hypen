export async function flushMicrotasks(count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Decode the internal transport envelope for tests asserting event semantics.
 * Protocol ownership itself is asserted against raw messages in DnD tests. */
export function semanticAction(name: string, payload: any): { name: string; payload: any } {
  return name === "__hypen_dispatch" ? { name: payload.action, payload: payload.payload } : { name, payload };
}

/** Minimal single-owner legacy lookup for host unit-test engines. */
export function testActionHandler<T>(handlers: Map<string, T>, name: string): T | undefined {
  if (handlers.has(name)) return handlers.get(name);
  const matches = [...handlers].filter(([key]) => key.startsWith("__hypen_scoped:") && key.endsWith(`:${name}`));
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}
