export interface KeyStrategy<T = unknown> {
  type: "global" | "session" | "withKey";
  resolve: (state: T, moduleName: string, sessionId: string) => string | null;
}

export function global<T>(): KeyStrategy<T> {
  return {
    type: "global",
    resolve: (_state, moduleName) => `global:${moduleName}`,
  };
}

export function session<T>(): KeyStrategy<T> {
  return {
    type: "session",
    resolve: (_state, _moduleName, sessionId) => `session:${sessionId}`,
  };
}

export function withKey<T>(
  fn: (state: T) => string | null | undefined,
): KeyStrategy<T> {
  return {
    type: "withKey",
    resolve: (state) => fn(state) ?? null,
  };
}
