import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { app } from "../packages/core/src/app";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Integration test: nested module Grid rendering.
 *
 * Mirrors the Rust SDK test `test_nested_module_grid_renders_items`:
 *   - App module with state { currentView: "search" }
 *   - Search module with state { searchQuery, explorePosts: [...3 items] }
 *   - App DSL references Search() as a nested component
 *   - Search DSL uses Grid(@state.explorePosts, key: "id") { Image(...) }
 *   - Asserts Grid element + 3 Image elements in initial patches
 */

const APP_UI = `module App {
  Column {
    If(condition: "@{state.currentView == 'search'}") {
      Search()
    }
  }
}`;

const SEARCH_UI = `module Search {
  Column {
    Input(placeholder: "Search")
    Grid(@state.explorePosts, key: "id") {
      Image(src: "@{item.imageUrl}")
    }
  }
}`;

interface AppState {
  currentView: string;
}

interface SearchState {
  searchQuery: string;
  explorePosts: { id: string; imageUrl: string }[];
}

type Client = {
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
  waitForMessage: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
};

function connectClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const waiters: Array<{
      predicate: (msg: any) => boolean;
      resolve: (msg: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let closed = false;

    const ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello" }));
      resolve({
        messages,
        send: (msg: any) => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
        waitForMessage: (predicate, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const existing = messages.find(predicate);
            if (existing) return res(existing);
            if (closed) return rej(new Error("WebSocket closed before message arrived"));
            const timer = setTimeout(() => rej(new Error("Timed out waiting for message")), timeoutMs);
            waiters.push({
              predicate,
              resolve: (msg) => { clearTimeout(timer); res(msg); },
              reject: rej,
              timer,
            });
          }),
      });
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    };

    ws.onclose = () => {
      closed = true;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error("WebSocket closed before message arrived"));
      }
      waiters.length = 0;
    };

    ws.onerror = (err) => reject(err);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Nested module Grid rendering", () => {
  let server: RemoteServer | null = null;
  let clients: Client[] = [];
  let tmpDir: string | null = null;
  const PORT = 19890;

  afterEach(async () => {
    for (const c of clients) c.close();
    clients = [];
    await wait(50);
    server?.stop();
    server = null;
    await wait(50);
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  test("Grid inside nested Search module renders 3 Image elements", async () => {
    // Create temp directory with Search component (folder-based discovery)
    tmpDir = mkdtempSync(join(tmpdir(), "hypen-test-"));
    const searchDir = join(tmpDir, "Search");
    mkdirSync(searchDir);
    writeFileSync(join(searchDir, "component.hypen"), SEARCH_UI);

    // Define App module (primary) with state
    const appModule = app
      .defineState<AppState>({ currentView: "search" })
      .build();

    // Define Search module (nested, registered via app.module())
    // This registers Search in the app registry so RemoteServer auto-discovers it
    const searchModule = app
      .module("Search")
      .defineState<SearchState>({
        searchQuery: "",
        explorePosts: [
          { id: "p1", imageUrl: "img1.jpg" },
          { id: "p2", imageUrl: "img2.jpg" },
          { id: "p3", imageUrl: "img3.jpg" },
        ],
      })
      .build();

    // Ensure the search module was built (side-effect: registered with app)
    void searchModule;

    // Set up RemoteServer:
    //   .app(app)    -> auto-discovers named modules from the app registry
    //   .source(dir) -> discovers Search component DSL from filesystem
    //   .module()    -> sets the primary (App) module
    //   .ui()        -> sets the root template
    server = new RemoteServer()
      .app(app)
      .module("App", appModule)
      .ui(APP_UI)
      .source(tmpDir);

    await server.listen(PORT);

    // Connect a WebSocket client and receive the initial tree
    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage((m) => m.type === "initialTree");

    expect(initMsg.type).toBe("initialTree");
    expect(initMsg.patches).toBeInstanceOf(Array);
    expect(initMsg.patches.length).toBeGreaterThan(0);

    // Extract all Create patches' element types
    const creates: string[] = initMsg.patches
      .filter((p: any) => p.type === "create")
      .map((p: any) => p.elementType);

    // Grid container must be present
    expect(creates).toContain("Grid");

    // 3 Image elements for the 3 explore posts
    const imageCount = creates.filter((t: string) => t === "Image").length;
    expect(imageCount).toBe(3);
  });
});
