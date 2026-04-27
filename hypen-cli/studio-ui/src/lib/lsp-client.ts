/**
 * Lightweight LSP client that talks JSON-RPC over a WebSocket to /ws/lsp.
 * The server-side bridges the WebSocket to the hypen-lsp subprocess via
 * Content-Length framed stdio.
 */

type PendingRequest = {
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HypenLspClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, (params: any) => void>();
  private documentVersions = new Map<string, number>();
  private projectDir: string;
  private disposables: { dispose(): void }[] = [];
  private connected = false;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectCallback: (() => void) | null = null;

  /** Max backoff delay for reconnection attempts. */
  static readonly MAX_RECONNECT_DELAY = 30_000;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Register a callback invoked after a successful reconnection. */
  onReconnect(callback: () => void): void {
    this.reconnectCallback = callback;
  }

  // --- Lifecycle ---

  connect(): Promise<void> {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    return this.connectInternal();
  }

  private connectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/lsp`);
      this.ws = ws;

      ws.onopen = () => {
        this.initialize()
          .then(() => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.documentVersions.clear();
            resolve();
          })
          .catch(reject);
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      ws.onerror = () => {
        if (!this.connected) reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        if (this.ws !== ws) return; // stale connection
        const wasConnected = this.connected;
        this.connected = false;
        for (const [, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error("Connection closed"));
        }
        this.pending.clear();

        if (!this.intentionalClose && wasConnected) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      HypenLspClient.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;

    console.log(
      `[LSP] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectInternal();
        console.log("[LSP] Reconnected successfully");
        this.reconnectCallback?.();
      } catch {
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Disconnected"));
    }
    this.pending.clear();
    this.documentVersions.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // --- JSON-RPC transport ---

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 10_000);

      this.pending.set(id, { resolve, reject, timer });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private sendNotification(method: string, params: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private handleMessage(data: string): void {
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    if ("id" in message && message.id != null) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ("method" in message) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) handler(message.params);
    }
  }

  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  // --- LSP initialization ---

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      processId: null,
      rootUri: `file://${this.projectDir}`,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: { snippetSupport: true },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          publishDiagnostics: { relatedInformation: true },
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
        },
      },
    });

    this.sendNotification("initialized", {});
  }

  // --- Document sync ---

  private fileUri(filePath: string): string {
    return `file://${this.projectDir}/${filePath}`;
  }

  openDocument(filePath: string, content: string, languageId: string): void {
    if (!this.connected) return;
    const uri = this.fileUri(filePath);
    this.documentVersions.set(uri, 1);
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  changeDocument(filePath: string, content: string): void {
    if (!this.connected) return;
    const uri = this.fileUri(filePath);
    const version = (this.documentVersions.get(uri) || 0) + 1;
    this.documentVersions.set(uri, version);
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  closeDocument(filePath: string): void {
    if (!this.connected) return;
    const uri = this.fileUri(filePath);
    this.documentVersions.delete(uri);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  // --- Feature requests ---

  async requestCompletion(
    filePath: string,
    line: number,
    character: number
  ): Promise<any> {
    return this.sendRequest("textDocument/completion", {
      textDocument: { uri: this.fileUri(filePath) },
      position: { line, character },
    });
  }

  async requestHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<any> {
    return this.sendRequest("textDocument/hover", {
      textDocument: { uri: this.fileUri(filePath) },
      position: { line, character },
    });
  }

  async requestSignatureHelp(
    filePath: string,
    line: number,
    character: number
  ): Promise<any> {
    return this.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri: this.fileUri(filePath) },
      position: { line, character },
    });
  }

  // --- Monaco provider registration ---

  registerMonacoProviders(monaco: any): void {
    // Completion
    this.disposables.push(
      monaco.languages.registerCompletionItemProvider("hypen", {
        triggerCharacters: [".", "@", "(", ":", " "],
        provideCompletionItems: async (model: any, position: any) => {
          const filePath = this.uriToRelativePath(model.uri.toString());
          if (!filePath) return { suggestions: [] };

          try {
            const result = await this.requestCompletion(
              filePath,
              position.lineNumber - 1,
              position.column - 1
            );
            const items = Array.isArray(result)
              ? result
              : result?.items || [];
            const word = model.getWordUntilPosition(position);
            const defaultRange = {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items.map((item: any) =>
                this.toMonacoCompletion(monaco, item, defaultRange)
              ),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      })
    );

    // Hover
    this.disposables.push(
      monaco.languages.registerHoverProvider("hypen", {
        provideHover: async (model: any, position: any) => {
          const filePath = this.uriToRelativePath(model.uri.toString());
          if (!filePath) return null;

          try {
            const result = await this.requestHover(
              filePath,
              position.lineNumber - 1,
              position.column - 1
            );
            if (!result) return null;
            return this.toMonacoHover(result);
          } catch {
            return null;
          }
        },
      })
    );

    // Signature help
    this.disposables.push(
      monaco.languages.registerSignatureHelpProvider("hypen", {
        signatureHelpTriggerCharacters: ["(", ","],
        signatureHelpRetriggerCharacters: [","],
        provideSignatureHelp: async (model: any, position: any) => {
          const filePath = this.uriToRelativePath(model.uri.toString());
          if (!filePath) return null;

          try {
            const result = await this.requestSignatureHelp(
              filePath,
              position.lineNumber - 1,
              position.column - 1
            );
            if (!result) return null;
            return { value: this.toMonacoSignatureHelp(result), dispose() {} };
          } catch {
            return null;
          }
        },
      })
    );

    // Diagnostics (server pushes these as notifications)
    this.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (!model) return;
      const markers = (params.diagnostics || []).map((d: any) =>
        this.toMonacoMarker(d)
      );
      monaco.editor.setModelMarkers(model, "hypen-lsp", markers);
    });
  }

  // --- Conversion helpers ---

  private uriToRelativePath(uri: string): string | null {
    const prefix = `file://${this.projectDir}/`;
    if (uri.startsWith(prefix)) return uri.slice(prefix.length);
    return null;
  }

  private toMonacoCompletion(monaco: any, item: any, defaultRange: any): any {
    let range = defaultRange;
    if (item.textEdit?.range) {
      range = this.lspRangeToMonaco(item.textEdit.range);
    }

    const result: any = {
      label: item.label,
      kind: this.lspCompletionKindToMonaco(monaco, item.kind),
      detail: item.detail,
      documentation: this.lspDocToString(item.documentation),
      insertText: item.textEdit?.newText || item.insertText || item.label,
      range,
      sortText: item.sortText,
      filterText: item.filterText,
    };

    if (item.insertTextFormat === 2) {
      result.insertTextRules =
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    return result;
  }

  private lspCompletionKindToMonaco(monaco: any, kind: number | undefined): number {
    if (kind == null) return monaco.languages.CompletionItemKind.Text;
    // LSP kind → Monaco kind name
    const map: Record<number, string> = {
      1: "Text",        2: "Method",    3: "Function",
      4: "Constructor",  5: "Field",     6: "Variable",
      7: "Class",        8: "Interface", 9: "Module",
      10: "Property",   11: "Unit",     12: "Value",
      13: "Enum",       14: "Keyword",  15: "Snippet",
      16: "Color",      17: "File",     18: "Reference",
      19: "Folder",     20: "EnumMember", 21: "Constant",
      22: "Struct",     23: "Event",    24: "Operator",
      25: "TypeParameter",
    };
    const name = map[kind] || "Text";
    return (
      monaco.languages.CompletionItemKind[name] ??
      monaco.languages.CompletionItemKind.Text
    );
  }

  private toMonacoHover(hover: any): any {
    const contents: { value: string }[] = [];
    if (hover.contents) {
      if (typeof hover.contents === "string") {
        contents.push({ value: hover.contents });
      } else if (hover.contents.kind) {
        // MarkupContent
        contents.push({ value: hover.contents.value });
      } else if (Array.isArray(hover.contents)) {
        for (const c of hover.contents) {
          contents.push({ value: typeof c === "string" ? c : c.value });
        }
      }
    }
    return {
      contents,
      range: hover.range ? this.lspRangeToMonaco(hover.range) : undefined,
    };
  }

  private toMonacoSignatureHelp(help: any): any {
    return {
      signatures: (help.signatures || []).map((sig: any) => ({
        label: sig.label,
        documentation: this.lspDocToString(sig.documentation),
        parameters: (sig.parameters || []).map((p: any) => ({
          label: p.label,
          documentation: this.lspDocToString(p.documentation),
        })),
      })),
      activeSignature: help.activeSignature ?? 0,
      activeParameter: help.activeParameter ?? 0,
    };
  }

  private toMonacoMarker(diagnostic: any): any {
    const severityMap: Record<number, number> = {
      1: 8, // Error
      2: 4, // Warning
      3: 2, // Info
      4: 1, // Hint
    };
    return {
      severity: severityMap[diagnostic.severity] ?? 8,
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      message: diagnostic.message,
      source: diagnostic.source || "hypen",
    };
  }

  private lspRangeToMonaco(range: any): any {
    return {
      startLineNumber: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLineNumber: range.end.line + 1,
      endColumn: range.end.character + 1,
    };
  }

  private lspDocToString(doc: any): string | undefined {
    if (!doc) return undefined;
    if (typeof doc === "string") return doc;
    return doc.value;
  }
}
