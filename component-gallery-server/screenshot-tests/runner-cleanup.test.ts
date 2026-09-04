import { describe, expect, test } from "bun:test";
import {
  cleanupOwnedResources,
  type OwnedBrowser,
  type OwnedProcess,
} from "./runner-cleanup";

class FakeProcess implements OwnedProcess {
  exitCode: number | null = null;
  signals: Array<string | number | undefined> = [];
  exited: Promise<number>;
  private resolveExit!: (code: number) => void;

  constructor(
    private readonly exitOn: string,
    private readonly exposesSignalExitCode = false,
  ) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }

  kill(signal?: string | number): void {
    this.signals.push(signal);
    if (signal === this.exitOn) {
      const resolvedCode = signal === "SIGKILL" ? 137 : 0;
      if (this.exposesSignalExitCode) this.exitCode = resolvedCode;
      this.resolveExit(resolvedCode);
    }
  }
}

describe("screenshot runner cleanup", () => {
  test("awaits browser close and graceful exits", async () => {
    const process = new FakeProcess("SIGTERM");
    let browserClosed = false;
    const browser: OwnedBrowser = {
      async close() {
        await Bun.sleep(1);
        browserClosed = true;
      },
    };

    const result = await cleanupOwnedResources({ browser, processes: [process], timeoutMs: 20 });

    expect(browserClosed).toBe(true);
    expect(process.signals).toEqual(["SIGTERM"]);
    expect(result).toEqual({
      browserClosed: true,
      processesExited: 1,
      processesForced: 0,
      processesStillRunning: 0,
    });
  });

  test("force-kills an owned process after the graceful deadline", async () => {
    const process = new FakeProcess("SIGKILL");

    const result = await cleanupOwnedResources({ browser: null, processes: [process], timeoutMs: 5 });

    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.processesForced).toBe(1);
    expect(result.processesStillRunning).toBe(0);
  });

  test("does not report signal-exited Bun processes as still running", async () => {
    const server = new FakeProcess("SIGTERM");
    const webServer = new FakeProcess("SIGTERM");

    const result = await cleanupOwnedResources({
      browser: null,
      processes: [server, webServer],
      timeoutMs: 5,
    });

    expect(server.exitCode).toBeNull();
    expect(webServer.exitCode).toBeNull();
    expect(result).toEqual({
      browserClosed: true,
      processesExited: 2,
      processesForced: 0,
      processesStillRunning: 0,
    });
  });

  test("bounds a stuck browser close and invokes its fallback", async () => {
    let forced = false;
    const browser: OwnedBrowser = {
      close: () => new Promise(() => {}),
      forceClose: () => { forced = true; },
    };

    const result = await cleanupOwnedResources({ browser, processes: [], timeoutMs: 5 });

    expect(forced).toBe(true);
    expect(result.browserClosed).toBe(false);
  });

  test("force-closes a browser when graceful close rejects", async () => {
    let forced = false;
    const browser: OwnedBrowser = {
      close: async () => { throw new Error("connection lost"); },
      forceClose: () => { forced = true; },
    };

    const result = await cleanupOwnedResources({ browser, processes: [], timeoutMs: 5 });

    expect(forced).toBe(true);
    expect(result.browserClosed).toBe(false);
  });
});
