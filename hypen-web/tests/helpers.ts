export async function flushMicrotasks(count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
