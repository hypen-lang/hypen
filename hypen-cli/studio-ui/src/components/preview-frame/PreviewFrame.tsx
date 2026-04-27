/**
 * Standalone preview page used inside Test Mode iframe cells.
 *
 * Two modes, selected by URL params:
 *
 *   /preview-frame?renderer=dom|canvas&file=<path>
 *     Local mode — fetches the .hypen file + optional sibling .ts module
 *     from studio-ui, boots a WASM Engine, and renders.
 *
 *   /preview-frame?renderer=dom|canvas&remoteUrl=<ws://…>
 *     Remote mode — connects to a dev server's RemoteEngine over WebSocket
 *     and renders the patches it streams back. No local engine/module.
 *
 * Each iframe is its own JS realm, so multiple cells share no state.
 */
import { useEffect, useRef, useState } from "react";
import { Engine } from "@hypen-space/web-engine";
import { app, HypenModuleInstance } from "@hypen-space/core";
import { createHypenClient as createDomClient } from "@hypen-space/web/dom";
import { createHypenClient as createCanvasClient } from "@hypen-space/web/canvas";
import { RemoteEngine } from "@hypen-space/core/remote/client";

type RendererKind = "dom" | "canvas";

function stripImports(source: string): string {
  return source.replace(/import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*/g, "").trim();
}

async function fetchFile(path: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.content === "string" ? data.content : null;
  } catch {
    return null;
  }
}

/** Normalise bare host:port / http origins to ws:// for RemoteEngine. */
function toWsUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, "ws");
  return `ws://${trimmed}`;
}

function mountTarget(host: HTMLDivElement, renderer: RendererKind): HTMLDivElement | HTMLCanvasElement {
  host.innerHTML = "";
  if (renderer === "canvas") {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);
    return canvas;
  }
  const div = document.createElement("div");
  div.style.position = "absolute";
  div.style.inset = "0";
  div.style.overflow = "auto";
  host.appendChild(div);
  return div;
}

export function PreviewFrame() {
  const params = new URLSearchParams(window.location.search);
  const file = params.get("file") ?? "";
  const rendererKind = (params.get("renderer") as RendererKind) ?? "dom";
  const remoteUrlRaw = params.get("remoteUrl") ?? "";

  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // The studio-ui shell (index.html) has `class="dark"` on <html> and <body>
  // with dark Tailwind styles. This route is loaded as an iframe, so strip
  // dark mode, force a white canvas, and reset inherited text color (Text
  // elements without `.color()` otherwise render as studio's muted gray).
  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    const prevHtmlColor = document.documentElement.style.color;
    const prevBodyColor = document.body.style.color;
    document.documentElement.style.background = "#ffffff";
    document.body.style.background = "#ffffff";
    document.documentElement.style.color = "#000000";
    document.body.style.color = "#000000";
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
      document.documentElement.style.color = prevHtmlColor;
      document.body.style.color = prevBodyColor;
    };
  }, []);

  // ─── Remote mode ───────────────────────────────────────
  useEffect(() => {
    if (!remoteUrlRaw || !hostRef.current) return;
    setReady(false);
    setError(null);

    const wsUrl = toWsUrl(remoteUrlRaw);
    const host = hostRef.current;
    const target = mountTarget(host, rendererKind);

    const remote = new RemoteEngine(wsUrl, { session: { props: { platform: "studio" } } });

    const client = rendererKind === "canvas"
      ? createCanvasClient(target as HTMLCanvasElement, remote as any)
      : createDomClient(target as HTMLDivElement, remote as any);
    const rendererInstance: any = client.renderer;

    remote
      .onStateUpdate((state) => {
        try { rendererInstance.updateState?.(state); } catch { /* optional */ }
      })
      .onSessionEstablished(() => {
        remote.subscribeState();
        // Clear any error left over from a previous failed connect attempt —
        // otherwise the overlay sticks after a successful reconnect.
        setError(null);
        setReady(true);
      })
      .onError((err) => setError(err.message ?? String(err)))
      .onDisconnect(() => setReady(false));

    remote.connect().then((result) => {
      if (!result.ok) {
        const msg = (result as any).error?.message ?? "connect failed";
        setError(`${wsUrl} — ${msg}`);
      }
    });

    return () => {
      try { remote.dispose(); } catch { /* already disposed */ }
      try { rendererInstance.clear?.(); } catch {}
      host.innerHTML = "";
    };
  }, [remoteUrlRaw, rendererKind]);

  // ─── Local mode (when remoteUrl is not set) ─────────────
  useEffect(() => {
    if (remoteUrlRaw || !file || !hostRef.current) return;

    let disposed = false;
    let engine: any = null;
    let moduleInstance: HypenModuleInstance | null = null;
    let rendererInstance: any = null;

    async function render() {
      if (!file || !hostRef.current) return;
      try {
        const hypenContent = await fetchFile(file);
        if (!hypenContent) throw new Error(`Failed to load ${file}`);

        const modulePath = file.replace(/\.hypen$/, ".ts");
        const moduleContent = await fetchFile(modulePath);

        engine = new Engine();
        await engine.init();
        if (disposed) return;

        const target = mountTarget(hostRef.current!, rendererKind);
        const client = rendererKind === "canvas"
          ? createCanvasClient(target as HTMLCanvasElement, engine)
          : createDomClient(target as HTMLDivElement, engine);
        rendererInstance = client.renderer;

        if (moduleContent) {
          const ts = await import("https://esm.sh/typescript@5.3.3");
          const jsCode = ts.transpileModule(moduleContent, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
          }).outputText;
          const moduleCode = jsCode
            .replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "")
            .replace(/export default/, "return");
          const createModule = new Function("app", moduleCode);
          const moduleDef = createModule(app);
          if (moduleDef) {
            moduleInstance = new HypenModuleInstance(engine, moduleDef);
            moduleInstance.onStateChange(() => {
              rendererInstance?.updateState?.(moduleInstance!.getState());
            });
          }
        } else {
          engine.setModule("main", [], [], {});
        }

        engine.renderSource(stripImports(hypenContent));
        setReady(true);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    }

    render();

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "reload" && !disposed) {
          disposed = true;
          setTimeout(() => { disposed = false; render(); }, 250);
        }
      } catch { /* ignore */ }
    };

    return () => {
      disposed = true;
      try { moduleInstance?.destroy?.(); } catch {}
      try { rendererInstance?.clear?.(); } catch {}
      try { engine?.reset?.(); } catch {}
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", () => { try { ws.close(); } catch {} }, { once: true });
      } else {
        try { ws.close(); } catch {}
      }
    };
  }, [remoteUrlRaw, file, rendererKind]);

  if (!remoteUrlRaw && !file) {
    return <div style={{ padding: 16, fontFamily: "system-ui", color: "#888" }}>No file or remoteUrl specified</div>;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#ffffff" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {!ready && !error && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", color: "#888", fontFamily: "system-ui", fontSize: 13,
        }}>
          {remoteUrlRaw ? `Connecting to ${toWsUrl(remoteUrlRaw)}…` : `Loading ${rendererKind}…`}
        </div>
      )}
      {error && (
        <div style={{
          position: "absolute", inset: 0, padding: 16,
          color: "#f88", fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre-wrap",
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default PreviewFrame;
