/**
 * Integration tests: spawn the actual hypen-lsp server with Bun and verify
 * Content-Length framed JSON-RPC communication works. This directly tests
 * Bun compatibility with vscode-languageserver/node.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { resolve } from "path";
import type { Subprocess } from "bun";

const LSP_DIR = resolve(import.meta.dir, "../../../../hypen-lsp");
const SERVER_PATH = resolve(LSP_DIR, "src/server.ts");

// --- Content-Length framing helpers ---

function frame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function makeRequest(id: number, method: string, params: any): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function makeNotification(method: string, params: any): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/** Read one Content-Length framed message from a ReadableStream. */
async function readMessage(
  stream: ReadableStream<Uint8Array>,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
  existingBuffer?: Buffer
): Promise<{ body: any; reader: ReadableStreamDefaultReader<Uint8Array>; buffer: Buffer }> {
  const r = reader ?? stream.getReader();
  let buffer = existingBuffer ?? Buffer.alloc(0);

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = buffer.slice(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        const contentLength = parseInt(match[1], 10);
        const messageStart = headerEnd + 4;
        const messageEnd = messageStart + contentLength;

        if (buffer.length >= messageEnd) {
          const body = JSON.parse(
            buffer.slice(messageStart, messageEnd).toString()
          );
          return { body, reader: r, buffer: buffer.slice(messageEnd) };
        }
      }
    }

    const { done, value } = await r.read();
    if (done) throw new Error("Stream ended before complete message");
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
  }
}

// --- Tests ---

describe("LSP server via Bun (integration)", () => {
  let proc: Subprocess | null = null;

  afterEach(() => {
    if (proc) {
      try {
        proc.stdin?.end();
        proc.kill();
      } catch {}
      proc = null;
    }
  });

  test("server starts and responds to initialize", async () => {
    proc = Bun.spawn(["bun", "run", SERVER_PATH, "--stdio"], {
      cwd: LSP_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send initialize request
    const initRequest = makeRequest(1, "initialize", {
      processId: null,
      rootUri: "file:///tmp/test-project",
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });
    proc.stdin!.write(frame(initRequest));
    proc.stdin!.flush();

    // Read response
    const { body: initResponse, reader, buffer } = await readMessage(
      proc.stdout as ReadableStream<Uint8Array>
    );

    expect(initResponse.jsonrpc).toBe("2.0");
    expect(initResponse.id).toBe(1);
    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.capabilities).toBeDefined();
  }, 15_000);

  test("server reports correct capabilities", async () => {
    proc = Bun.spawn(["bun", "run", SERVER_PATH, "--stdio"], {
      cwd: LSP_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const initRequest = makeRequest(1, "initialize", {
      processId: null,
      rootUri: "file:///tmp/test-project",
      capabilities: {},
    });
    proc.stdin!.write(frame(initRequest));
    proc.stdin!.flush();

    const { body, reader, buffer } = await readMessage(
      proc.stdout as ReadableStream<Uint8Array>
    );
    const caps = body.result.capabilities;

    expect(caps.completionProvider).toBeDefined();
    expect(caps.completionProvider.triggerCharacters).toContain(".");
    expect(caps.completionProvider.triggerCharacters).toContain("@");
    expect(caps.hoverProvider).toBe(true);
    expect(caps.signatureHelpProvider).toBeDefined();
    expect(caps.signatureHelpProvider.triggerCharacters).toContain("(");
    expect(caps.documentSymbolProvider).toBe(true);
    expect(caps.documentFormattingProvider).toBe(true);
  }, 15_000);

  test("full lifecycle: init → open → completion → shutdown", async () => {
    proc = Bun.spawn(["bun", "run", SERVER_PATH, "--stdio"], {
      cwd: LSP_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // 1. Initialize
    const initRequest = makeRequest(1, "initialize", {
      processId: null,
      rootUri: "file:///tmp/test-project",
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
        },
      },
    });
    proc.stdin!.write(frame(initRequest));
    proc.stdin!.flush();

    let { body: initResp, reader, buffer } = await readMessage(
      proc.stdout as ReadableStream<Uint8Array>
    );
    expect(initResp.id).toBe(1);
    expect(initResp.result).toBeDefined();

    // 2. Initialized notification
    proc.stdin!.write(frame(makeNotification("initialized", {})));
    proc.stdin!.flush();

    // 3. Open a document
    const docUri = "file:///tmp/test-project/test.hypen";
    proc.stdin!.write(
      frame(
        makeNotification("textDocument/didOpen", {
          textDocument: {
            uri: docUri,
            languageId: "hypen",
            version: 1,
            text: "Col",
          },
        })
      )
    );
    proc.stdin!.flush();

    // The server may send diagnostics for the opened document — read them
    // We need to drain any notifications before sending our completion request
    await new Promise((r) => setTimeout(r, 500));

    // 4. Request completion
    proc.stdin!.write(
      frame(
        makeRequest(2, "textDocument/completion", {
          textDocument: { uri: docUri },
          position: { line: 0, character: 3 },
        })
      )
    );
    proc.stdin!.flush();

    // Read messages until we get the completion response (id=2)
    // There may be diagnostic notifications in between
    let completionResp: any = null;
    for (let attempts = 0; attempts < 10; attempts++) {
      const result = await readMessage(
        proc.stdout as ReadableStream<Uint8Array>,
        reader,
        buffer
      );
      reader = result.reader;
      buffer = result.buffer;

      if (result.body.id === 2) {
        completionResp = result.body;
        break;
      }
    }

    expect(completionResp).not.toBeNull();
    expect(completionResp.error).toBeUndefined();
    // Result should be an array of completion items or a CompletionList
    const items = Array.isArray(completionResp.result)
      ? completionResp.result
      : completionResp.result?.items || completionResp.result;
    expect(items).toBeDefined();
    expect(Array.isArray(items)).toBe(true);

    // 5. Shutdown
    proc.stdin!.write(frame(makeRequest(3, "shutdown", null)));
    proc.stdin!.flush();

    // Read shutdown response
    let shutdownResp: any = null;
    for (let attempts = 0; attempts < 10; attempts++) {
      const result = await readMessage(
        proc.stdout as ReadableStream<Uint8Array>,
        reader,
        buffer
      );
      reader = result.reader;
      buffer = result.buffer;

      if (result.body.id === 3) {
        shutdownResp = result.body;
        break;
      }
    }

    expect(shutdownResp).not.toBeNull();
    expect(shutdownResp.error).toBeUndefined();

    // 6. Exit
    proc.stdin!.write(frame(makeNotification("exit", null)));
    proc.stdin!.flush();

    // Process should exit cleanly
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    proc = null; // already exited
  }, 30_000);

  test("Content-Length framing: multiple messages in one write", async () => {
    proc = Bun.spawn(["bun", "run", SERVER_PATH, "--stdio"], {
      cwd: LSP_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send initialize + initialized in one write
    const init = frame(
      makeRequest(1, "initialize", {
        processId: null,
        rootUri: "file:///tmp/test",
        capabilities: {},
      })
    );
    const initialized = frame(makeNotification("initialized", {}));
    proc.stdin!.write(init + initialized);
    proc.stdin!.flush();

    const { body } = await readMessage(
      proc.stdout as ReadableStream<Uint8Array>
    );
    expect(body.id).toBe(1);
    expect(body.result.capabilities).toBeDefined();
  }, 15_000);
});
