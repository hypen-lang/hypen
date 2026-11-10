/**
 * Theme: scheme merge, alias resolution, system-scheme following, sparse
 * re-render through the real WASM engine (asserted on patches), per-session
 * forks, `context.theme`, and `color-scheme` on the DOM render root.
 */
import { describe, expect, test } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import { createTheme, resolveTokenAliases, type Theme, type Tokens } from "../packages/core/src/theme";
import { HypenGlobalContext } from "../packages/core/src/context";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, type FakeElement } from "./fake-dom";
import { flushMicrotasks } from "./helpers";

ensureFakeDomGlobals();

const tokens: Tokens = {
  color: {
    brand: "#0066ff",
    primary: "{color.brand}",
    surface: "#ffffff",
    ink: "#111111",
  },
  space: { sm: 8, md: 16 },
  font: { body: "Inter" },
};
const dark: Tokens = { color: { brand: "#66a3ff", surface: "#111111", ink: "#f5f5f5" } };
const sepia: Tokens = { color: { surface: "#f4ecd8" } };

const makeTheme = (extra: Parameters<typeof createTheme>[0] = {}) =>
  createTheme({ tokens, schemes: { dark, sepia }, ...extra });

/** `name -> value` for every prop carried by create / setProp patches. */
function props(patches: Patch[]): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const p of patches as any[]) {
    if (p.type === "create") out.push(...(Object.entries(p.props ?? {}) as Array<[string, unknown]>));
    else if (p.type === "setProp") out.push([p.name, p.value]);
  }
  return out;
}
const values = (patches: Patch[]) => props(patches).map(([, v]) => v);

async function engineWith(source: string, theme: Theme = makeTheme()) {
  const engine = new Engine();
  await engine.init();
  const patches: Patch[] = [];
  engine.setRenderCallback((batch) => patches.push(...batch));
  const instance = new HypenModuleInstance(engine, app.defineState({}).build());
  await instance.waitForReady();
  theme.attach(engine);
  engine.renderSource(source);
  return { engine, patches, theme, instance };
}

describe("tokens", () => {
  test("the active scheme's overrides merge over the base tokens", () => {
    const theme = makeTheme({ scheme: "dark" });
    expect(theme.scheme).toBe("dark");
    expect(theme.token("color.surface")).toBe("#111111");
    expect(theme.token("space.md")).toBe(16);
    expect(theme.token("font.body")).toBe("Inter");
  });

  test("a scheme without overrides uses the base tokens", () => {
    const theme = makeTheme({ scheme: "light" });
    expect(theme.tokens).toEqual(resolveTokenAliases(tokens));
  });

  test("aliases resolve after the scheme merge, so semantic tokens follow the scheme", () => {
    const theme = makeTheme();
    expect(theme.token("color.primary")).toBe("#0066ff");
    theme.setScheme("dark");
    expect(theme.token("color.primary")).toBe("#66a3ff");
  });

  test("aliases chain, keep their type, and can point at a group", () => {
    const resolved = resolveTokenAliases({
      a: 4,
      b: "{a}",
      c: "{b}",
      group: { x: 1 },
      same: "{group}",
      text: "not {a} alias",
    });
    expect(resolved).toEqual({ a: 4, b: 4, c: 4, group: { x: 1 }, same: { x: 1 }, text: "not {a} alias" });
  });

  test("missing and cyclic aliases are reported and left as written", () => {
    const problems: string[] = [];
    const resolved = resolveTokenAliases(
      { a: "{b}", b: "{a}", c: "{nope}", self: { inner: "{self}" } },
      (p) => problems.push(p)
    );
    expect(resolved).toEqual({ a: "{b}", b: "{a}", c: "{nope}", self: { inner: "{self}" } });
    expect(problems).toHaveLength(4);
    expect(problems.filter((p) => p.includes("cycle"))).toHaveLength(3);
  });

  test("token() reports a missing token once", () => {
    const missing: string[] = [];
    const theme = makeTheme({ onMissingToken: (path, scheme) => missing.push(`${scheme}:${path}`) });
    expect(theme.token("color.nope")).toBeUndefined();
    expect(theme.token("color.nope")).toBeUndefined();
    expect(theme.has("color.nope")).toBe(false);
    expect(missing).toEqual(["light:color.nope"]);
  });

  test("extend() merges tokens into the base set or one scheme", () => {
    const theme = makeTheme();
    theme.extend({ radius: { md: 8 } });
    theme.extend({ radius: { md: 12 } }, "dark");
    expect(theme.token("radius.md")).toBe(8);
    theme.setScheme("dark");
    expect(theme.token("radius.md")).toBe(12);
    expect(theme.token("color.ink")).toBe("#f5f5f5");
  });

  test("cssVariables() flattens the active tokens", () => {
    const vars = makeTheme({ scheme: "dark" }).cssVariables();
    expect(vars["--color-primary"]).toBe("#66a3ff");
    expect(vars["--space-md"]).toBe("16");
  });
});

describe("schemes", () => {
  test("defaults to following the system scheme", () => {
    const theme = makeTheme();
    expect(theme.meta).toEqual({
      scheme: "light",
      preference: "system",
      system: "light",
      schemes: ["dark", "sepia"],
    });
    theme.setSystemScheme("dark");
    expect(theme.scheme).toBe("dark");
    expect(theme.token("color.surface")).toBe("#111111");
  });

  test("an explicit preference wins over the system scheme, which is remembered", () => {
    const theme = makeTheme({ scheme: "sepia" });
    theme.setSystemScheme("dark");
    expect(theme.scheme).toBe("sepia");
    expect(theme.token("color.surface")).toBe("#f4ecd8");
    theme.setScheme("system");
    expect(theme.scheme).toBe("dark");
  });

  test("toggle() flips between light and dark from whichever is in effect", () => {
    const theme = makeTheme({ systemScheme: "dark" });
    theme.toggle();
    expect(theme.preference).toBe("light");
    theme.toggle();
    expect(theme.preference).toBe("dark");
  });

  test("an unknown scheme throws from setScheme and falls back to system at construction", () => {
    const theme = makeTheme({ scheme: "neon" });
    expect(theme.preference).toBe("system");
    expect(() => theme.setScheme("neon")).toThrow(/Unknown color scheme "neon"/);
  });

  test("onChange fires on effective changes only", () => {
    const theme = makeTheme();
    const seen: string[] = [];
    const off = theme.onChange((meta) => seen.push(`${meta.preference}/${meta.scheme}`));
    theme.setScheme("dark");
    theme.setScheme("dark");
    theme.setSystemScheme("dark");
    theme.setSystemScheme("dark");
    off();
    theme.setScheme("light");
    expect(seen).toEqual(["dark/dark", "dark/dark"]);
  });

  test("watchSystem() follows prefers-color-scheme and stops when asked", () => {
    const g = globalThis as { matchMedia?: unknown };
    const original = g.matchMedia;
    let listener: ((e: { matches: boolean }) => void) | null = null;
    g.matchMedia = (query: string) => {
      expect(query).toBe("(prefers-color-scheme: dark)");
      return {
        matches: true,
        addEventListener: (_: string, l: (e: { matches: boolean }) => void) => (listener = l),
        removeEventListener: () => (listener = null),
      };
    };
    try {
      const theme = makeTheme();
      const stop = theme.watchSystem();
      expect(theme.scheme).toBe("dark");
      listener!({ matches: false });
      expect(theme.scheme).toBe("light");
      stop();
      expect(listener).toBeNull();
    } finally {
      g.matchMedia = original;
    }
  });

  test("fork() has its own preference over shared tokens", () => {
    const host = makeTheme();
    const a = host.fork();
    const b = host.fork("dark");
    expect(a.scheme).toBe("light");
    expect(b.scheme).toBe("dark");
    a.setScheme("sepia");
    expect(host.scheme).toBe("light");
    expect(b.scheme).toBe("dark");
    host.extend({ radius: { md: 8 } });
    // Shared store: a fork picks the new token up the next time it rebuilds.
    b.setScheme("light");
    expect(b.token("radius.md")).toBe(8);
  });
});

describe("engine integration", () => {
  test("tokens resolve in applicators, references and templates", async () => {
    const { patches } = await engineWith(
      `Column {
         Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
         Text("@{theme.font.body} / @{appearance.scheme}")
       }.backgroundColor(@theme.color.surface)`
    );
    expect(props(patches)).toEqual(
      expect.arrayContaining([
        ["color.0", "#0066ff"],
        ["padding.0", 16],
        ["backgroundColor.0", "#ffffff"],
      ])
    );
    expect(values(patches)).toContain("Inter / light");
  });

  test("a scheme switch re-renders only the props whose token changed", async () => {
    const { patches, theme } = await engineWith(
      `Column {
         Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
         Text("@{theme.font.body}")
       }.backgroundColor(@theme.color.surface)`
    );
    patches.length = 0;
    theme.setScheme("dark");
    await flushMicrotasks();
    expect(patches.every((p) => (p as any).type === "setProp")).toBe(true);
    expect(props(patches).sort()).toEqual(
      [
        ["backgroundColor.0", "#111111"],
        ["color.0", "#66a3ff"],
      ].sort()
    );

    patches.length = 0;
    theme.setSystemScheme("light"); // preference is explicit: nothing to do
    await flushMicrotasks();
    expect(props(patches)).toEqual([]);
  });

  test("a handler can switch scheme mid-dispatch; several changes publish once", async () => {
    const theme = makeTheme();
    const engine = new Engine();
    await engine.init();
    const patches: Patch[] = [];
    let batches = 0;
    engine.setRenderCallback((batch) => {
      batches++;
      patches.push(...batch);
    });
    const ctx = new HypenGlobalContext();
    ctx.setTheme(theme);
    const instance = new HypenModuleInstance(
      engine,
      app
        .defineState({})
        .onAction("go", ({ context }) => {
          context.theme!.setScheme("sepia");
          context.theme!.setScheme("dark");
        })
        .build(),
      null,
      ctx
    );
    await instance.waitForReady();
    theme.attach(engine);
    engine.renderSource(`Text("x").color(@theme.color.ink)`);
    patches.length = 0;
    batches = 0;
    engine.dispatchAction("go");
    await flushMicrotasks(5);
    expect(props(patches)).toEqual([["color.0", "#f5f5f5"]]);
    expect(batches).toBe(1);
  });

  test("handlers reach the instance as context.theme", async () => {
    const engine = new Engine();
    await engine.init();
    const theme = makeTheme();
    const ctx = new HypenGlobalContext();
    ctx.setTheme(theme);
    const seen: unknown[] = [];
    const instance = new HypenModuleInstance(
      engine,
      app
        .defineState({})
        .onAction("toggle", ({ context }) => {
          context.theme!.toggle();
          seen.push(context.theme!.scheme, context.theme!.token("color.surface"));
        })
        .build(),
      null,
      ctx
    );
    await instance.waitForReady();
    engine.renderSource(`Text("x")`);
    engine.dispatchAction("toggle");
    await flushMicrotasks(5);
    expect(seen).toEqual(["dark", "#111111"]);
  });
});

describe("render root", () => {
  test("DOMRenderer.setColorScheme marks the root and sets color-scheme for light/dark", () => {
    const container = document.createElement("div") as unknown as HTMLElement;
    const renderer = new DOMRenderer(container, {} as any);
    renderer.setColorScheme("dark");
    expect((container as unknown as FakeElement).attributes["data-hypen-scheme"]).toBe("dark");
    expect(container.style.getPropertyValue("color-scheme")).toBe("dark");
    renderer.setColorScheme("sepia");
    expect((container as unknown as FakeElement).attributes["data-hypen-scheme"]).toBe("sepia");
    expect(container.style.getPropertyValue("color-scheme")).toBe("");
  });

  test("Hypen publishes the theme before the first render and tracks scheme changes", async () => {
    const { Hypen } = await import("../packages/web-engine/src/hypen");
    const theme = makeTheme({ scheme: "dark" });
    const hypen = new Hypen({ theme });
    // Same seam as the i18n suite: the Node engine shares the BaseEngine API.
    const engine = new Engine();
    await engine.init();
    (hypen as unknown as { engine: Engine }).engine = engine;
    hypen.registerComponent("App", app.defineState({}).build(), `Text("x").color(@theme.color.ink)`);
    const container = document.createElement("div") as unknown as FakeElement;
    await hypen.render("App", container as unknown as HTMLElement);
    expect(container.attributes["data-hypen-scheme"]).toBe("dark");
    expect(hypen.getGlobalContext().theme).toBe(theme);
    expect(hypen.getTheme()).toBe(theme);

    theme.setScheme("light");
    expect(container.attributes["data-hypen-scheme"]).toBe("light");
    await hypen.unmount();
  });
});

describe("RemoteServer", () => {
  const PORT = 19931;

  function connect(port: number) {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    const waitFor = async (predicate: (m: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const hit = messages.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("Timed out waiting for message");
    };
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello" }));
        resolve();
      };
      ws.onerror = reject;
    });
    return { messages, ws, waitFor, opened };
  }

  test("each session forks the theme: one client's scheme switch does not touch another's", async () => {
    const { RemoteServer } = await import("../packages/server/src/remote/server");
    const host = makeTheme();
    const server = new RemoteServer()
      .module(
        "App",
        app
          .defineState({})
          .onAction("toggle", ({ context }) => context.theme!.toggle())
          .build()
      )
      .ui(`module App { Button { Text("x") }.onClick(@actions.toggle).backgroundColor(@theme.color.surface) }`)
      .theme(host);
    await server.listen(PORT);
    const a = connect(PORT);
    const b = connect(PORT);
    try {
      await Promise.all([a.opened, b.opened]);
      for (const client of [a, b]) {
        const init = await client.waitFor((m) => m.type === "initialTree");
        expect(props(init.patches)).toContainEqual(["backgroundColor.0", "#ffffff"]);
      }

      a.ws.send(JSON.stringify({ type: "dispatchAction", module: "App", action: "toggle" }));
      const patch = await a.waitFor((m) => m.type === "patch");
      expect(props(patch.patches)).toEqual([["backgroundColor.0", "#111111"]]);

      await new Promise((r) => setTimeout(r, 100));
      expect(b.messages.filter((m) => m.type === "patch")).toEqual([]);
      expect(host.scheme).toBe("light");
    } finally {
      a.ws.close();
      b.ws.close();
      await new Promise((r) => setTimeout(r, 50));
      server.stop();
    }
  });
});

describe("cross-SDK fixtures", () => {
  const fixture = require("../../engine-compatibility-tests/fixtures/theme/resolve.json") as {
    cases: Array<{
      name: string;
      tokens: Tokens;
      schemes: Record<string, Tokens>;
      preference: string;
      system: "light" | "dark";
      expected: { scheme: string; tokens: Tokens; problems: number };
    }>;
  };
  for (const c of fixture.cases) {
    test(c.name, () => {
      const theme = createTheme({
        tokens: c.tokens,
        schemes: c.schemes,
        scheme: c.preference,
        systemScheme: c.system,
      });
      expect(theme.scheme).toBe(c.expected.scheme);
      expect(theme.tokens).toEqual(c.expected.tokens);
      expect(theme.problems).toHaveLength(c.expected.problems);
    });
  }
});

describe("RemoteServer: client color scheme", () => {
  const PORT = 19932;

  test("hello.colorScheme seeds the session theme; a colorScheme message re-renders it", async () => {
    const { RemoteServer } = await import("../packages/server/src/remote/server");
    const { RemoteEngine } = await import("../packages/core/src/remote/client");
    const server = new RemoteServer()
      .module(
        "App",
        app
          .defineState({})
          .onAction("pinLight", ({ context }) => context.theme!.setScheme("light"))
          .build()
      )
      .ui(`module App { Button { Text("x") }.onClick(@actions.pinLight).backgroundColor(@theme.color.surface) }`)
      .theme(makeTheme());
    await server.listen(PORT);
    const client = new RemoteEngine(`ws://localhost:${PORT}`, { colorScheme: "dark", autoReconnect: false });
    const seen: Array<[string, unknown]> = [];
    client.onPatches((patches) => seen.push(...props(patches as Patch[])));
    const settle = () => new Promise((r) => setTimeout(r, 100));
    try {
      await client.connect();
      await settle();
      // First frame is already dark: no light paint followed by a flip.
      expect(seen.filter(([name]) => name === "backgroundColor.0")).toEqual([["backgroundColor.0", "#111111"]]);

      seen.length = 0;
      client.setColorScheme("light");
      await settle();
      expect(seen).toEqual([["backgroundColor.0", "#ffffff"]]);

      // An explicit preference stops following the client.
      client.dispatchAction("pinLight");
      await settle();
      seen.length = 0;
      client.setColorScheme("dark");
      await settle();
      expect(seen).toEqual([]);
    } finally {
      client.dispose();
      await settle();
      server.stop();
    }
  });

  test("a malformed scheme is ignored in hello and as a message", async () => {
    const { RemoteServer } = await import("../packages/server/src/remote/server");
    const server = new RemoteServer()
      .module("App", app.defineState({}).build())
      .ui(`module App { Text("x").color(@theme.color.surface) }`)
      .theme(makeTheme());
    await server.listen(PORT + 1);
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${PORT + 1}`);
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
    try {
      ws.send(JSON.stringify({ type: "hello", colorScheme: "neon" }));
      await new Promise((r) => setTimeout(r, 150));
      const init = messages.find((m) => m.type === "initialTree");
      expect(props(init.patches)).toContainEqual(["color.0", "#ffffff"]);
      ws.send(JSON.stringify({ type: "colorScheme", scheme: 7 }));
      ws.send(JSON.stringify({ type: "colorScheme" }));
      await new Promise((r) => setTimeout(r, 150));
      expect(messages.filter((m) => m.type === "patch")).toEqual([]);
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      server.stop();
    }
  });
});
