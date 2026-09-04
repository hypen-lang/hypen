export interface OwnedProcess {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: string | number): void;
}

export interface OwnedBrowser {
  close(): Promise<void>;
  forceClose?(): void;
}

export interface CleanupResult {
  browserClosed: boolean;
  processesExited: number;
  processesForced: number;
  processesStillRunning: number;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function exitsWithin(
  processes: readonly OwnedProcess[],
  timeoutMs: number,
): Promise<Set<OwnedProcess>> {
  const exited = new Set<OwnedProcess>();
  const allExits = Promise.all(processes.map(process =>
    process.exited.then(
      () => { exited.add(process); },
      () => { exited.add(process); },
    )
  ));
  await settlesWithin(allExits, timeoutMs);
  return exited;
}

async function closeBrowser(browser: OwnedBrowser | null, timeoutMs: number): Promise<boolean> {
  if (!browser) return true;

  let closeSucceeded = false;
  const closeSettled = await settlesWithin(
    Promise.resolve()
      .then(() => browser.close())
      .then(() => { closeSucceeded = true; }),
    timeoutMs,
  );
  if (!closeSettled || !closeSucceeded) {
    try {
      browser.forceClose?.();
    } catch {
      // The browser may have exited between the timeout and the fallback.
    }
  }
  return closeSettled && closeSucceeded;
}

/**
 * Shut down resources created by the screenshot runner, never resources it
 * merely discovered and reused. Both graceful and forced waits are bounded so
 * teardown itself cannot keep Bun alive indefinitely.
 */
export async function cleanupOwnedResources(options: {
  browser: OwnedBrowser | null;
  processes: readonly OwnedProcess[];
  timeoutMs?: number;
}): Promise<CleanupResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const processes = [...new Set(options.processes)].filter(process => process.exitCode === null);

  for (const process of processes) {
    try {
      process.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }

  const browserClose = closeBrowser(options.browser, timeoutMs);
  const gracefulExits = await exitsWithin(processes, timeoutMs);

  // Bun keeps exitCode null when a process exits because of a signal. The
  // proc.exited promise is therefore the authoritative completion signal.
  const stubborn = processes.filter(process =>
    !gracefulExits.has(process) && process.exitCode === null
  );
  for (const process of stubborn) {
    try {
      process.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  const forcedExits = await exitsWithin(stubborn, timeoutMs);

  const processesStillRunning = stubborn.filter(process =>
    !forcedExits.has(process) && process.exitCode === null
  ).length;
  return {
    browserClosed: await browserClose,
    processesExited: processes.length - processesStillRunning,
    processesForced: stubborn.length,
    processesStillRunning,
  };
}
