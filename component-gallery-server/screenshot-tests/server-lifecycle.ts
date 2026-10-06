export interface ServerProcess {
  readonly exitCode: number | null;
}

export interface ServerLifecycleOptions {
  label: string;
  port: number;
  probe: () => Promise<boolean>;
  portOccupied: () => Promise<boolean>;
  ownerDetails: () => Promise<string>;
  spawn: () => ServerProcess;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ServerLifecycleResult {
  reused: boolean;
  process?: ServerProcess;
}

export async function ensureServerLifecycle(
  options: ServerLifecycleOptions,
): Promise<ServerLifecycleResult> {
  if (await options.probe()) return { reused: true };

  if (await options.portOccupied()) {
    const owner = await options.ownerDetails();
    throw new Error(
      `Port ${options.port} is occupied, but it is not a healthy ${options.label}. ` +
      `Stop or reconfigure the listener; it was not killed. Listener details:\n${owner}`,
    );
  }

  const process = options.spawn();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const sleep = options.sleep ?? Bun.sleep;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await options.probe()) return { reused: false, process };
    if (process.exitCode !== null) {
      throw new Error(
        `${options.label} exited with code ${process.exitCode} before its health check passed.`,
      );
    }
    await sleep(pollIntervalMs);
  }

  if (process.exitCode !== null) {
    throw new Error(
      `${options.label} exited with code ${process.exitCode} before its health check passed.`,
    );
  }
  throw new Error(
    `${options.label} did not pass its health check within ${timeoutMs}ms on port ${options.port}.`,
  );
}

export async function probeComponentGallery(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    return typeof value.ready === "boolean" &&
      typeof value.connected === "boolean" &&
      typeof value.initialTreeSent === "boolean" &&
      typeof value.generation === "number" &&
      Array.isArray(value.expectedFixtures) &&
      Array.isArray(value.loadedFixtures);
  } catch {
    return false;
  }
}

export async function probeWebGallery(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    return value.service === "hypen-web-gallery" && value.status === "ok";
  } catch {
    return false;
  }
}
