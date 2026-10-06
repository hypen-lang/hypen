/**
 * MCP over stdio: newline-delimited JSON-RPC on stdin/stdout.
 *
 * The transport every MCP client can launch without a network — Claude
 * Desktop, Claude Code, the MCP Inspector all spawn a process and talk to it
 * this way. Its two rules are easy to break and unpleasant to debug:
 *
 *   1. **One JSON value per line, and nothing else on stdout.** A stray
 *      `console.log` from anywhere in the process corrupts the stream and the
 *      client disconnects with a parse error that names this file. So
 *      diagnostics go to stderr, which the protocol leaves free-form.
 *   2. **A notification is never answered.** `handle` returning `null` is that
 *      case, and it must produce no write at all — not `null`, not `{}`.
 *
 * Framing is the only thing this file knows. Every protocol decision belongs
 * to `HypenMcpServer`, and every capability decision to the engine's guard.
 */

import { HypenMcpServer, type JsonRpcNotification } from "./server.js";
import type { AgentEngine } from "./types.js";

export type StdioTransportOptions = {
  /** The running app. */
  engine: AgentEngine;
  /** Reported in `initialize`. Name your app here; the client shows it. */
  serverInfo?: { name: string; version: string };
  /** Byte or string source. Defaults to `process.stdin`. */
  input?: AsyncIterable<Uint8Array | string>;
  /** Sink for framed lines. Defaults to `process.stdout`. */
  write?: (chunk: string) => void;
  /** Diagnostics. Defaults to `process.stderr` — never stdout. */
  log?: (message: string) => void;
  /**
   * Re-read the manifest on a timer, so a change that happens while the
   * client is idle still produces a `list_changed` notification.
   *
   * Off by default: every incoming request refreshes anyway, so polling only
   * buys the notification for a client that is sitting still — worth it for a
   * long-lived agent session, waste for a one-shot script.
   */
  pollIntervalMs?: number;
};

/** A stdio-framed MCP server over one running app. */
export class StdioTransport {
  readonly server: HypenMcpServer;

  private readonly input: AsyncIterable<Uint8Array | string>;
  private readonly write: (chunk: string) => void;
  private readonly log: (message: string) => void;
  private readonly pollIntervalMs: number | undefined;

  private buffer = "";
  private decoder = new TextDecoder();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StdioTransportOptions) {
    const stdio = (globalThis as { process?: any }).process;
    this.write = options.write ?? ((chunk) => stdio?.stdout?.write(chunk));
    this.log = options.log ?? ((message) => stdio?.stderr?.write(`${message}\n`));
    this.input = options.input ?? stdio?.stdin;
    this.pollIntervalMs = options.pollIntervalMs;

    this.server = new HypenMcpServer({
      engine: options.engine,
      serverInfo: options.serverInfo,
      onNotification: (notification) => this.send(notification),
    });
  }

  /**
   * Consume the input stream until it ends. Resolves when stdin closes,
   * which is how an MCP client asks a stdio server to shut down.
   */
  async start(): Promise<void> {
    // Say once what the app declared and could not publish. A developer
    // whose action is missing from tools/list has no other way to find out
    // that the reason is its name.
    for (const item of this.server.degraded) {
      this.log(`[hypen-agent] ${item.kind} '${item.name}' not published: ${item.reason}`);
    }

    if (this.pollIntervalMs !== undefined) {
      this.timer = setInterval(() => {
        try {
          this.server.refresh();
        } catch (err) {
          this.log(`[hypen-agent] manifest refresh failed: ${describe(err)}`);
        }
      }, this.pollIntervalMs);
      // Never hold the process open on the poll alone: the stdin stream is
      // what defines the session's lifetime.
      (this.timer as { unref?: () => void }).unref?.();
    }

    try {
      for await (const chunk of this.input) {
        this.consume(chunk);
      }
      // A trailing line with no newline is still a complete message.
      this.flush();
    } finally {
      this.stop();
    }
  }

  /** Stop polling. Safe to call twice; does not close the input. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Feed one raw chunk. Partial lines are held until their newline arrives. */
  consume(chunk: Uint8Array | string): void {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Handle whatever is left in the buffer as a final line. */
  flush(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim() !== "") this.handleLine(rest);
  }

  /** Handle one complete line. */
  handleLine(line: string): void {
    // Blank lines are framing, not messages; some clients pad with them.
    if (line.trim() === "") return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (err) {
      // Parse failures carry a null id: there is no id to echo when the
      // bytes did not parse.
      this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${describe(err)}` },
      });
      return;
    }

    let response: unknown;
    try {
      response = this.server.handle(message);
    } catch (err) {
      // The server itself failing is a bug, not a refusal — refusals are
      // returned as error responses. Answer with an id where there is one so
      // the client is not left waiting on a request that will never return.
      const id = (message as { id?: string | number | null })?.id ?? null;
      this.log(`[hypen-agent] handler threw: ${describe(err)}`);
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${describe(err)}` },
      });
      return;
    }

    // `null` is a notification: answering one is a protocol violation.
    if (response !== null) this.send(response);
  }

  private send(message: JsonRpcNotification | unknown): void {
    this.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * Serve one app over stdio until stdin closes.
 *
 * ```ts
 * await serveStdio({ engine, serverInfo: { name: "my-app", version: "1.0.0" } });
 * ```
 */
export async function serveStdio(options: StdioTransportOptions): Promise<void> {
  await new StdioTransport(options).start();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
