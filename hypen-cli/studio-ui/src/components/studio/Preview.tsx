import { useEffect, useRef, useState } from "react";
import { actionLogEntry } from "@/lib/action-log";
import { cn } from "@/lib/utils";
import { RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OpenFile, ConsoleLog } from "./Studio";

// Static imports - bundled by Bun at build time (same as landing page)
import { Engine } from "@hypen-space/web-engine";
import { localWasmInitOptions } from "@/lib/wasm-urls";
import { app, HypenModuleInstance, getStateSnapshot } from "@hypen-space/core";
import { DOMRenderer } from "@hypen-space/web/dom";
import { RemoteEngine } from "@hypen-space/core/remote/client";
import { pickPreviewSource, type PreviewSource } from "@/lib/preview-source";
import type { ModuleStates, StateOverride } from "@/lib/state-history";

// Parse import statements from Hypen DSL
function parseImports(source: string): Array<{ names: string[]; source: string }> {
  const imports: Array<{ names: string[]; source: string }> = [];
  const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;

  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const [, namedImports, defaultImport, importSource] = match;
    if (!importSource) continue;

    let names: string[];
    if (namedImports) {
      names = namedImports.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
    } else if (defaultImport) {
      names = [defaultImport];
    } else {
      continue;
    }

    imports.push({ names, source: importSource });
  }

  return imports;
}

// Remove import statements from source
function stripImports(source: string): string {
  return source.replace(
    /import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*/g,
    ""
  ).trim();
}

// Resolve a relative path from a base path
function resolvePath(basePath: string, relativePath: string): string {
  // Get the directory of the base path
  const baseDir = basePath.includes("/")
    ? basePath.substring(0, basePath.lastIndexOf("/"))
    : "";

  // Handle relative path
  const parts = relativePath.split("/");
  const baseParts = baseDir ? baseDir.split("/") : [];

  for (const part of parts) {
    if (part === "..") {
      baseParts.pop();
    } else if (part !== "." && part !== "") {
      baseParts.push(part);
    }
  }

  return baseParts.join("/");
}

/** Logical size of the previewed device (iPhone 15 Pro, in CSS px / pt). */
const PHONE_DEVICE = { w: 393, h: 852 };
/** On-screen width of the phone's glass inside the 14px bezel. */
const PHONE_SCREEN_W = 322;
const PHONE_SCALE = PHONE_SCREEN_W / PHONE_DEVICE.w;
const PHONE_SCREEN_H = Math.round(PHONE_DEVICE.h * PHONE_SCALE);

type PreviewProps = {
  activeFile: string | null;
  openFiles: OpenFile[];
  remoteUrl?: string | null;
  style?: React.CSSProperties;
  /** Time-travel target: the primary's state plus every module's, when known. */
  overrideState?: StateOverride | null;
  onLog: (level: ConsoleLog["level"], message: string) => void;
  onActionLog: (name: string, payload?: any) => void;
  onStateChange: (state: Record<string, any>, modules?: ModuleStates) => void;
  /** Components the studio engine could not resolve for this preview. */
  unresolvedComponents?: string[];
};

// Module-level engine singleton to avoid WASM memory corruption with StrictMode
/**
 * Transpile a `.ts` module through the studio server's Bun.Transpiler
 * (`/api/transpile`) — no CDN-hosted typescript needed in the browser.
 */
async function transpileTs(code: string): Promise<string> {
  const res = await fetch("/api/transpile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Transpile failed: ${data.error ?? res.status}`);
  }
  return data.code as string;
}

let globalEngine: any | null = null;
let engineInitPromise: Promise<any> | null = null;
let globalRenderCallback: ((patches: any[]) => void) | null = null;

async function getOrCreateEngine(): Promise<any> {
  if (globalEngine) return globalEngine;
  if (engineInitPromise) return engineInitPromise;

  engineInitPromise = (async () => {
    const engine = new Engine();
    // Prefer the studio-served project WASM over the CDN default.
    await engine.init((await localWasmInitOptions()) ?? {});
    globalEngine = engine;
    return engine;
  })();

  return engineInitPromise;
}

export function Preview({
  activeFile,
  openFiles,
  remoteUrl,
  style,
  overrideState,
  onLog,
  onActionLog,
  onStateChange,
  unresolvedComponents = [],
}: PreviewProps) {
  // Use a separate ref for the Hypen renderer container (not managed by React)
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererContainerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const engineRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const observableStateRef = useRef<any>(null);
  const timeTravelingRef = useRef(false);
  const remoteEngineRef = useRef<RemoteEngine | null>(null);

  // Where the preview streams from (see lib/preview-source.ts). `null`
  // while we wait for the studio engine to finish booting.
  const [source, setSource] = useState<PreviewSource | null>(
    remoteUrl ? { kind: "remote", url: remoteUrl, external: true } : null
  );
  // Bumped by the refresh button in remote mode: a fresh RemoteEngine =
  // a fresh session (initial state, initial route).
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const connectUrl = source?.kind === "remote" ? source.url : null;
  const isLocal = source?.kind === "local";
  const isExternal = source?.kind === "remote" && source.external;

  // Cache for resolved components
  const componentCacheRef = useRef<Map<string, string>>(new Map());
  // Map component names to their source paths (from imports)
  const importMapRef = useRef<Map<string, string>>(new Map());

  // Create a non-React-managed container for the renderer
  useEffect(() => {
    if (containerRef.current && !rendererContainerRef.current) {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.inset = "0";
      div.style.overflowY = "auto";
      div.style.overflowX = "hidden";
      // Same fullscreen contract as the `hypen dev` client (#app): a flex
      // column whose root component stretches to the device frame.
      div.className = "hypen-preview-root";
      containerRef.current.appendChild(div);
      rendererContainerRef.current = div;
    }
    return () => {
      if (rendererContainerRef.current && containerRef.current) {
        try {
          containerRef.current.removeChild(rendererContainerRef.current);
        } catch (e) {
          // Ignore if already removed
        }
        rendererContainerRef.current = null;
      }
    };
  }, []);

  // Resolve the preview source. An explicit remote URL (server-based
  // project, `hypen run --studio`) wins; otherwise stream from the
  // studio-hosted engine so the real module handlers run — the in-browser
  // engine only wires the entry's own module, so taps on nested modules
  // (Home, Counter, ...) and `@router.push` would have no handler.
  useEffect(() => {
    if (remoteUrl) {
      setSource({ kind: "remote", url: remoteUrl, external: true });
      return;
    }
    let cancelled = false;
    const deadline = Date.now() + 20_000;
    (async () => {
      while (!cancelled) {
        let status = null;
        try {
          const res = await fetch("/api/engine/status");
          if (res.ok) status = await res.json();
        } catch {
          // Studio server restarting — keep polling until the deadline.
        }
        const next = pickPreviewSource(status, window.location, Date.now() > deadline);
        if (next) {
          if (cancelled) return;
          if (next.kind === "local") {
            onLog(
              "warn",
              `Studio engine unavailable${next.reason ? ` (${next.reason})` : ""} — ` +
                "previewing the open .hypen file in-browser; only its own module's actions run."
            );
          }
          setSource(next);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteUrl]);

  // Remote mode: stream from a RemoteServer — the studio-hosted engine
  // (default) or the project's own server (`hypen run --studio`, server-based
  // projects). Actions go to the server, where the module handlers live.
  useEffect(() => {
    if (!connectUrl || !rendererContainerRef.current) return;

    onLog("info", `Connecting to ${isExternal ? "remote" : "studio"} engine: ${connectUrl}`);
    setLoading(true);
    rendererContainerRef.current.innerHTML = "";

    const remote = new RemoteEngine(connectUrl, {
      session: { props: { platform: "studio" } },
      // The studio engine drops every client on a source change (close
      // 1012, hot reload); redial fast so edits show up promptly.
      ...(isExternal ? {} : { reconnectInterval: 300 }),
    });
    remoteEngineRef.current = remote;

    // Create a DOMRenderer with an engine adapter that forwards actions to RemoteServer
    const makeRemoteRenderer = () =>
      new DOMRenderer(rendererContainerRef.current!, {
        dispatchAction: (name: string, payload?: unknown) => {
          remote.dispatchAction(name, payload);
          const entry = actionLogEntry(name, payload);
          onActionLog(entry.name, entry.payload);
        },
      });
    rendererRef.current = makeRemoteRenderer();

    remote
      .onPatches((patches) => {
        if (rendererRef.current) {
          rendererRef.current.applyPatches(patches);
        }
      })
      .onStateUpdate((state, modules) => {
        if (!timeTravelingRef.current) {
          onStateChange(state as Record<string, any>, modules);
        }
      })
      .onSessionEstablished((info) => {
        onLog("info", `Remote session: ${info.sessionId} (${info.isNew ? "new" : "restored"})`);
        // Each (re)established session streams a full initial tree —
        // reset the renderer so a hot-reload reconnect doesn't append a
        // duplicate tree under the old one.
        if (rendererContainerRef.current) {
          rendererContainerRef.current.innerHTML = "";
          rendererRef.current = makeRemoteRenderer();
        }
        // Subscribe to state updates for the state panel and time-travel —
        // every module's state (nested and route modules too), not only
        // the entry's. Older servers ignore `modules` and stream the entry.
        remote.subscribeState({ modules: true });
        setEngineReady(true);
        setLoading(false);
      })
      .onError((error) => {
        onLog("error", `Remote error: ${error.message}`);
        setLoading(false);
      })
      .onDisconnect(() => {
        onLog("warn", "Remote engine disconnected");
        setEngineReady(false);
      })
      .onConnect(() => {
        onLog("info", "Remote engine connected");
      });

    remote.connect().then((result) => {
      if (!result.ok) {
        onLog("error", `Failed to connect: ${(result as any).error?.message || "unknown"}`);
        setLoading(false);
      }
    });

    return () => {
      remote.dispose();
      remoteEngineRef.current = null;
      setEngineReady(false);
      if (rendererContainerRef.current) {
        rendererContainerRef.current.innerHTML = "";
      }
    };
  }, [connectUrl, reconnectNonce]);

  // Initialize engine (local mode only)
  const initEngine = async () => {
    if (!isLocal) return; // Skip local engine when streaming from a server
    if (!rendererContainerRef.current) return;

    try {
      onLog("info", "Initializing Hypen engine...");

      const engine = await getOrCreateEngine();
      engineRef.current = engine;

      const renderer = new DOMRenderer(rendererContainerRef.current, engine as any);
      rendererRef.current = renderer;

      // Use global callback pattern to handle StrictMode remounts
      globalRenderCallback = (patches: any[]) => {
        if (rendererRef.current) {
          rendererRef.current.applyPatches(patches);
        }
      };

      if (!(engine as any).__callbackRegistered) {
        engine.setRenderCallback((patches: any[]) => {
          if (globalRenderCallback) {
            globalRenderCallback(patches);
          }
        });
        (engine as any).__callbackRegistered = true;
      }

      // Set up component resolver for imports
      // Built-in element types that don't need resolution
      const BUILTIN_ELEMENTS = new Set([
        "Text", "Column", "Row", "Stack", "Box", "Button", "Image",
        "Spacer", "Divider", "Input", "Textarea", "Checkbox", "Switch",
        "Select", "Option", "List", "LazyColumn", "LazyRow",
        "Link", "Icon", "Badge", "Card", "Dialog", "Overlay",
      ]);

      if (!(engine as any).__resolverRegistered) {
        engine.setComponentResolver((componentName: string, contextPath: string | null) => {
          // Skip built-in elements — engine handles these natively
          if (BUILTIN_ELEMENTS.has(componentName)) {
            return null;
          }

          // Check if we have this component in our import map
          const importPath = importMapRef.current.get(componentName);
          if (!importPath) {
            onLog("debug", `Component "${componentName}" not found in imports`);
            return null;
          }

          // Check cache
          if (componentCacheRef.current.has(importPath)) {
            const cachedSource = componentCacheRef.current.get(importPath)!;
            const cleanSource = stripImports(cachedSource);
            onLog("info", `Resolving ${componentName} (${cleanSource.length} chars)`);
            return {
              source: cleanSource,
              path: importPath,
            };
          }

          onLog("warn", `Component ${componentName} not in cache`);
          return null;
        });
        (engine as any).__resolverRegistered = true;
      }

      setEngineReady(true);
      onLog("info", "Hypen engine initialized");
    } catch (e: any) {
      onLog("error", `Failed to init engine: ${e.message}`);
    }
  };

  // Refresh preview. Remote mode: reconnect (fresh session). Local mode:
  // re-render the open buffers in the in-browser engine.
  const refreshPreview = async () => {
    if (connectUrl) {
      setReconnectNonce((n) => n + 1);
      return;
    }
    if (!rendererContainerRef.current || !isLocal) return;

    setLoading(true);

    try {
      // Find .hypen file
      const hypenFile = openFiles.find((f) => f.path.endsWith(".hypen"));
      if (!hypenFile) {
        onLog("warn", "No .hypen file open");
        setLoading(false);
        return;
      }

      // Initialize engine if needed
      if (!engineRef.current) {
        await initEngine();
      }

      if (!engineRef.current || !rendererRef.current) {
        onLog("warn", "Engine not ready");
        setLoading(false);
        return;
      }

      // Destroy previous module instance if any
      if (observableStateRef.current?.destroy) {
        await observableStateRef.current.destroy();
        observableStateRef.current = null;
      }

      // Full reset: clears tree, module, component registry, dependencies.
      // clearTree() alone keeps resolved components cached so changes
      // to child .ts/.hypen files would be ignored on re-render.
      rendererContainerRef.current.innerHTML = "";
      rendererRef.current.clear();
      engineRef.current.reset();
      // The WASM reset() rebuilds the engine core from scratch, which also
      // drops the default primitives Engine.init() registered. Without
      // them every Column/Text/Row is routed to the component resolver and
      // logs a "did not resolve" warning. Re-register them.
      engineRef.current.wasmEngine?.registerDefaultPrimitives?.();

      // Parse explicit imports and build import map
      const imports = parseImports(hypenFile.content);
      importMapRef.current.clear();
      componentCacheRef.current.clear();

      for (const imp of imports) {
        const resolvedPath = resolvePath(hypenFile.path, imp.source);
        for (const name of imp.names) {
          importMapRef.current.set(name, resolvedPath);
          onLog("info", `Import: ${name} -> ${resolvedPath}`);
        }
      }

      // Auto-discover components referenced by bare name (no import):
      // scan the open component folder's CHILD directories (nested
      // components) and its SIBLING directories — the scaffold layout is
      // src/components/{App,Home,Counter}, so `Home()` inside App's
      // template lives in a sibling folder — mirroring the server's
      // discovery conventions.
      const hypenDir = hypenFile.path.includes("/")
        ? hypenFile.path.substring(0, hypenFile.path.lastIndexOf("/"))
        : "";

      const scanDirForComponents = async (scanDir: string, skipName?: string) => {
        try {
          const res = await fetch(`/api/files/${encodeURIComponent(scanDir)}`);
          if (res.ok) {
            const dirData = await res.json();
            // dirData is the directory listing; find child directories
            const childDirs = Array.isArray(dirData)
              ? dirData.filter((item: any) => item.type === "directory")
              : (dirData.children || []).filter((item: any) => item.type === "directory");

            for (const child of childDirs) {
              const componentName = child.name;
              if (componentName === skipName) continue;
              if (importMapRef.current.has(componentName)) continue;

              // Try component.hypen first, then component.ts (for .ui() inline templates)
              const hypenPath = `${scanDir}/${componentName}/component.hypen`;
              const tsPath = `${scanDir}/${componentName}/component.ts`;

              // Prefer editor buffer over disk for unsaved changes
              const openHypenFile = openFiles.find((f) => f.path === hypenPath);
              const hypenContent = openHypenFile?.content ?? await (async () => {
                try {
                  const hypenRes = await fetch(`/api/files/${encodeURIComponent(hypenPath)}`);
                  if (hypenRes.ok) {
                    const data = await hypenRes.json();
                    return data.content || null;
                  }
                } catch (_) { /* no .hypen file */ }
                return null;
              })();

              if (hypenContent) {
                importMapRef.current.set(componentName, hypenPath);
                componentCacheRef.current.set(hypenPath, hypenContent);
                onLog("info", `Discovered component: ${componentName} (${hypenPath})`);
                continue;
              }

              // Check for .ts file with .ui() inline template
              // Prefer editor buffer over disk for unsaved changes
              const openTsFile = openFiles.find((f) => f.path === tsPath);
              const tsContent = openTsFile?.content ?? await (async () => {
                try {
                  const tsRes = await fetch(`/api/files/${encodeURIComponent(tsPath)}`);
                  if (tsRes.ok) {
                    const data = await tsRes.json();
                    return data.content || null;
                  }
                } catch (_) { /* no .ts file */ }
                return null;
              })();

              if (tsContent) {
                const uiMatch = tsContent.match(/\.ui\s*\(\s*`([\s\S]*?)`\s*\)/);
                if (uiMatch) {
                  const inlineTemplate = uiMatch[1];
                  importMapRef.current.set(componentName, tsPath);
                  componentCacheRef.current.set(tsPath, inlineTemplate);
                  onLog("info", `Discovered inline component: ${componentName} (${tsPath})`);
                }
              }
            }
          }
        } catch (e: any) {
          onLog("warn", `Failed to scan ${scanDir} for components: ${e.message}`);
        }
      };

      if (hypenDir) {
        await scanDirForComponents(hypenDir);
        const slash = hypenDir.lastIndexOf("/");
        if (slash > 0) {
          // Parent of the component folder = the components root; scan it
          // for sibling components, skipping our own folder.
          await scanDirForComponents(
            hypenDir.substring(0, slash),
            hypenDir.substring(slash + 1)
          );
        }
      }

      // Register discovered components' modules with the engine so their
      // `@{state.*}` bindings resolve in the preview (mirrors the remote
      // session's registerNestedModules). Action HANDLERS only run when the
      // preview streams from the studio engine; this in-browser fallback is
      // layout-first.
      for (const [name, path] of importMapRef.current) {
        const tsPath = path.endsWith(".ts")
          ? path
          : path.replace(/component\.hypen$/, "component.ts");
        try {
          const openTs = openFiles.find((f) => f.path === tsPath);
          let tsContent: string | null = openTs?.content ?? null;
          if (tsContent === null) {
            const r = await fetch(`/api/files/${encodeURIComponent(tsPath)}`);
            if (r.ok) tsContent = (await r.json()).content ?? null;
          }
          if (!tsContent) continue;
          const jsCode = await transpileTs(tsContent);
          const moduleCode = jsCode
            .replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "")
            .replace(/export default/, "return");
          const def = new Function("app", moduleCode)(app);
          const stateKeys =
            def?.initialState && typeof def.initialState === "object"
              ? Object.keys(def.initialState)
              : [];
          const hasActions = (def?.actions?.length ?? 0) > 0;
          if (def && (stateKeys.length > 0 || hasActions)) {
            (engineRef.current as any).registerModule?.(
              name,
              def.actions ?? [],
              stateKeys,
              def.initialState ?? {}
            );
            onLog("info", `Registered nested module: ${name}`);
          }
        } catch (e: any) {
          onLog("warn", `Nested module ${name} failed to load: ${e.message}`);
        }
      }

      // Pre-load explicitly imported components not yet cached
      for (const [name, path] of importMapRef.current) {
        if (!componentCacheRef.current.has(path)) {
          // Check if already open
          const openFile = openFiles.find((f) => f.path === path);
          if (openFile) {
            componentCacheRef.current.set(path, openFile.content);
          } else {
            // Fetch the file
            try {
              const res = await fetch(`/api/files/${encodeURIComponent(path)}`);
              const data = await res.json();
              if (data.content) {
                componentCacheRef.current.set(path, data.content);
                onLog("info", `Pre-loaded: ${name} from ${path}`);
              } else {
                onLog("warn", `Component file not found: ${path}`);
              }
            } catch (e: any) {
              onLog("error", `Failed to load ${name}: ${e.message}`);
            }
          }
        }
      }

      // Find matching module file - check open files first, then fetch
      const modulePath = hypenFile.path.replace(".hypen", ".ts");
      let moduleContent: string | null = null;

      // Check if already open
      const openModuleFile = openFiles.find((f) => f.path === modulePath);
      if (openModuleFile) {
        moduleContent = openModuleFile.content;
      } else {
        // Try to fetch the module file
        try {
          const res = await fetch(`/api/files/${encodeURIComponent(modulePath)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.content) {
              moduleContent = data.content;
              onLog("info", `Auto-loaded module: ${modulePath}`);
            }
          }
        } catch (e) {
          // Module file doesn't exist, that's fine
        }
      }

      if (moduleContent) {
        // Transpile and setup module (server-side, see transpileTs)
        const jsCode = await transpileTs(moduleContent);

        const moduleCode = jsCode
          .replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "")
          .replace(/export default/, "return");

        const createModule = new Function("app", moduleCode);
        const moduleDef = createModule(app);

        if (moduleDef) {
          // Wrap action handlers to log to Studio panel
          if (moduleDef.handlers?.onAction) {
            const originalHandlers = new Map(moduleDef.handlers.onAction);
            moduleDef.handlers.onAction = new Map();
            for (const [actionName, handler] of originalHandlers) {
              moduleDef.handlers.onAction.set(actionName, (ctx: any) => {
                onActionLog(actionName, ctx.action?.payload);
                return handler(ctx);
              });
            }
          }

          // Use HypenModuleInstance — handles state registration, action handlers,
          // __hypen_bind support, proper state path prefixing, and lifecycle
          const moduleInstance = new HypenModuleInstance(engineRef.current, moduleDef);

          // Track state changes for renderer and state inspector
          moduleInstance.onStateChange(() => {
            const snapshot = moduleInstance.getState();
            rendererRef.current.updateState(snapshot);
            // Don't record state changes caused by time-travel into history
            if (!timeTravelingRef.current) {
              onStateChange(snapshot);
            }
          });

          // Store for cleanup on next refresh
          observableStateRef.current = moduleInstance;

          onStateChange(moduleInstance.getState());
        }
      } else {
        // No module, just set empty state
        engineRef.current.setModule("main", [], [], {});
      }

      // Strip imports and render
      const sourceWithoutImports = stripImports(hypenFile.content);
      onLog("info", `Rendering source (${sourceWithoutImports.length} chars, ${imports.length} imports)`);
      engineRef.current.renderSource(sourceWithoutImports);
      onLog("info", "Preview refreshed");
    } catch (e: any) {
      onLog("error", `Preview error: ${e.message}`);
    }

    setLoading(false);
  };

  // Time-travel: push historical state to the module instance (local or remote)
  useEffect(() => {
    if (!overrideState) return;

    timeTravelingRef.current = true;
    try {
      if (remoteEngineRef.current) {
        // Remote mode: send state override to the server, which restores
        // every listed module, re-renders and sends patches back.
        remoteEngineRef.current.updateState(overrideState.state, overrideState.modules);
      } else if (observableStateRef.current) {
        // Local mode: update the module instance directly
        observableStateRef.current.updateState(overrideState.state);
      }
    } finally {
      timeTravelingRef.current = false;
    }
  }, [overrideState]);

  // Auto-refresh on file change (local mode only)
  // Only track files relevant to the current preview: the entry .hypen file,
  // its sibling .ts module, and child component files under the same directory.
  const hypenFile = openFiles.find((f) => f.path.endsWith(".hypen"));
  const hypenDir = hypenFile?.path.includes("/")
    ? hypenFile.path.substring(0, hypenFile.path.lastIndexOf("/"))
    : "";

  const relevantContentKey = openFiles
    .filter((f) => {
      if (!f.path.endsWith(".hypen") && !f.path.endsWith(".ts")) return false;
      if (!hypenDir) return true;
      // Only files within or under the entry component directory
      return f.path.startsWith(hypenDir);
    })
    .map((f) => f.content)
    .join("\0");

  useEffect(() => {
    if (!isLocal || !hypenFile) return;

    const timer = setTimeout(() => {
      refreshPreview();
    }, 500);

    return () => clearTimeout(timer);
  }, [relevantContentKey, isLocal]);

  return (
    <div className="border-l border-border bg-card/50 flex flex-col shrink-0" style={style}>
      {/* Header */}
      <div className="h-10 border-b border-border flex items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Smartphone className="w-4 h-4" />
          Preview
          {isExternal && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-400 font-medium normal-case">
              Remote
            </span>
          )}
          {isLocal && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400 font-medium normal-case"
              title="Studio engine unavailable: rendering in-browser, only the entry module's actions run"
            >
              Layout only
            </span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={refreshPreview}
          disabled={loading || !source}
          title={connectUrl ? "Restart preview session" : "Re-render preview"}
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Preview Container */}
      <div className="flex-1 p-4 flex items-start justify-center overflow-auto bg-gradient-to-b from-zinc-800 to-zinc-900">
        {/* Phone Frame — matches landing page Iphone15Pro structure */}
        <div
          className="bg-black rounded-[60px] border-[14px] border-black shadow-2xl overflow-hidden shrink-0"
          style={{ width: PHONE_SCREEN_W + 28, height: PHONE_SCREEN_H + 28 }}
        >
          {/* Screen — white backdrop + black default text colour so apps
              without explicit bg/color match the device default (and Test
              Mode, which forces these in PreviewFrame). Without this, the
              black phone bezel shows through and Text nodes inherit the
              studio shell's dark-theme foreground, which vanishes on the
              first white-backed component the user adds. */}
          <div className="relative w-full h-full overflow-hidden rounded-[46px] bg-white text-black">
            {/* Device viewport: laid out at the phone's logical size
                (iPhone 15 Pro, 393x852pt) and scaled down to the frame, so
                the app wraps and centres the way it does on a device
                instead of reflowing into a ~320px column. */}
            <div
              ref={containerRef}
              className="absolute left-0 top-0"
              style={{
                width: PHONE_DEVICE.w,
                height: PHONE_DEVICE.h,
                transform: `scale(${PHONE_SCALE})`,
                transformOrigin: "0 0",
              }}
            />
            {/* Referenced-but-undefined components render nothing (the
                engine's unknown-component behaviour); say so on the
                preview instead of leaving a silently blank area. */}
            {engineReady && !isLocal && unresolvedComponents.length > 0 && (
              <div
                data-testid="unresolved-components"
                className="absolute left-3 right-3 top-10 z-10 rounded-lg border border-amber-400 bg-amber-50/95 px-3 py-2 text-[11px] leading-snug text-amber-900 shadow"
              >
                <span className="font-semibold">Unknown component{unresolvedComponents.length === 1 ? "" : "s"}:</span>{" "}
                {unresolvedComponents.map((n) => `${n}()`).join(", ")}
                <div className="text-amber-800/80">
                  Referenced in a template but not defined (deleted or misspelled?) — rendered as nothing.
                </div>
              </div>
            )}
            {/* Overlay for loading state */}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
                <RefreshCw className="w-6 h-6 animate-spin text-zinc-400" />
              </div>
            )}
            {!engineReady && !loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 text-center p-4 text-sm z-10">
                <p className="mb-2">{connectUrl || !source ? "Connecting..." : "Preview not ready"}</p>
                <p className="text-xs text-zinc-500">
                  {isExternal
                    ? "Waiting for remote engine connection"
                    : connectUrl || !source
                      ? "Waiting for the studio engine"
                      : "Open a .hypen file and click refresh"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
