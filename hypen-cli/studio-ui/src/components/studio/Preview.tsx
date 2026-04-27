import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OpenFile, ConsoleLog } from "./Studio";

// Static imports - bundled by Bun at build time (same as landing page)
import { Engine } from "@hypen-space/web-engine";
import { app, HypenModuleInstance, getStateSnapshot } from "@hypen-space/core";
import { createHypenClient } from "@hypen-space/web/dom";
import { RemoteEngine } from "@hypen-space/core/remote/client";

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

type PreviewProps = {
  activeFile: string | null;
  openFiles: OpenFile[];
  remoteUrl?: string | null;
  style?: React.CSSProperties;
  overrideState?: Record<string, any> | null;
  onLog: (level: ConsoleLog["level"], message: string) => void;
  onActionLog: (name: string, payload?: any) => void;
  onStateChange: (state: Record<string, any>) => void;
};

// Module-level engine singleton to avoid WASM memory corruption with StrictMode
let globalEngine: any | null = null;
let engineInitPromise: Promise<any> | null = null;

async function getOrCreateEngine(): Promise<any> {
  if (globalEngine) return globalEngine;
  if (engineInitPromise) return engineInitPromise;

  engineInitPromise = (async () => {
    const engine = new Engine();
    await engine.init();
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

  // Remote mode: connect to a RemoteServer (used with `hypen run --studio`)
  useEffect(() => {
    if (!remoteUrl || !rendererContainerRef.current) return;

    onLog("info", `Connecting to remote engine: ${remoteUrl}`);
    setLoading(true);

    const remote = new RemoteEngine(remoteUrl, {
      session: { props: { platform: "studio" } },
    });
    remoteEngineRef.current = remote;

    // Create a DOMRenderer with an engine adapter that forwards actions to RemoteServer.
    // Adapter wraps dispatchAction (to log) but delegates onPatches/onStateUpdate to remote
    // so createHypenClient can subscribe via the same patch stream.
    const adapter: any = {
      dispatchAction: (name: string, payload?: unknown) => {
        remote.dispatchAction(name, payload);
        onActionLog(name, payload);
      },
      onPatches: (cb: any) => remote.onPatches(cb),
    };
    const { renderer } = createHypenClient(rendererContainerRef.current, adapter);
    rendererRef.current = renderer;

    remote
      .onStateUpdate((state) => {
        if (!timeTravelingRef.current) {
          onStateChange(state as Record<string, any>);
        }
      })
      .onSessionEstablished((info) => {
        onLog("info", `Remote session: ${info.sessionId} (${info.isNew ? "new" : "restored"})`);
        // Subscribe to state updates for the state panel and time-travel
        remote.subscribeState();
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
      if (rendererContainerRef.current) {
        rendererContainerRef.current.innerHTML = "";
      }
    };
  }, [remoteUrl]);

  // Initialize engine (local mode only)
  const initEngine = async () => {
    if (remoteUrl) return; // Skip local engine when in remote mode
    if (!rendererContainerRef.current) return;

    try {
      onLog("info", "Initializing Hypen engine...");

      const engine = await getOrCreateEngine();
      engineRef.current = engine;

      // createHypenClient registers a setRenderCallback on the engine that
      // closes over this renderer; on a StrictMode remount it overwrites the
      // previous registration to point at the new renderer (last-writer-wins),
      // which is the intent the previous globalRenderCallback indirection
      // achieved manually.
      const { renderer } = createHypenClient(rendererContainerRef.current, engine as any);
      rendererRef.current = renderer;

      // Set up component resolver for imports
      // Built-in element types that don't need resolution
      const BUILTIN_ELEMENTS = new Set([
        "Text", "Column", "Row", "Stack", "Box", "Button", "Image",
        "Spacer", "Divider", "Input", "Textarea", "Checkbox", "Switch",
        "Select", "Option", "List", "LazyColumn", "LazyRow", "ScrollView",
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

  // Refresh preview (local mode only — remote mode streams patches automatically)
  const refreshPreview = async () => {
    if (!rendererContainerRef.current || remoteUrl) return;

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

      // Auto-discover child component directories
      // e.g., for "src/components/App/component.hypen", scan "src/components/App/" for subdirs
      const hypenDir = hypenFile.path.includes("/")
        ? hypenFile.path.substring(0, hypenFile.path.lastIndexOf("/"))
        : "";

      if (hypenDir) {
        try {
          const res = await fetch(`/api/files/${encodeURIComponent(hypenDir)}`);
          if (res.ok) {
            const dirData = await res.json();
            // dirData is the directory listing; find child directories
            const childDirs = Array.isArray(dirData)
              ? dirData.filter((item: any) => item.type === "directory")
              : (dirData.children || []).filter((item: any) => item.type === "directory");

            for (const child of childDirs) {
              const componentName = child.name;
              if (importMapRef.current.has(componentName)) continue;

              // Try component.hypen first, then component.ts (for .ui() inline templates)
              const hypenPath = `${hypenDir}/${componentName}/component.hypen`;
              const tsPath = `${hypenDir}/${componentName}/component.ts`;

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
          onLog("warn", `Failed to scan for child components: ${e.message}`);
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
        // Transpile and setup module
        const ts = await import("https://esm.sh/typescript@5.3.3");
        const jsCode = ts.transpileModule(moduleContent, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
          },
        }).outputText;

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
        // Remote mode: send state override to the server, which re-renders and sends patches back
        remoteEngineRef.current.updateState(overrideState);
      } else if (observableStateRef.current) {
        // Local mode: update the module instance directly
        observableStateRef.current.updateState(overrideState);
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
    if (remoteUrl || !hypenFile) return;

    const timer = setTimeout(() => {
      refreshPreview();
    }, 500);

    return () => clearTimeout(timer);
  }, [relevantContentKey]);

  return (
    <div className="border-l border-border bg-card/50 flex flex-col shrink-0" style={style}>
      {/* Header */}
      <div className="h-10 border-b border-border flex items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Smartphone className="w-4 h-4" />
          Preview
          {remoteUrl && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-400 font-medium normal-case">
              Remote
            </span>
          )}
        </span>
        {!remoteUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshPreview}
            disabled={loading}
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </Button>
        )}
      </div>

      {/* Preview Container */}
      <div className="flex-1 p-4 flex items-start justify-center overflow-auto bg-gradient-to-b from-zinc-800 to-zinc-900">
        {/* Phone Frame — matches landing page Iphone15Pro structure */}
        <div className="w-[350px] h-[710px] bg-black rounded-[60px] border-[14px] border-black shadow-2xl overflow-hidden">
          {/* Screen — white backdrop + black default text colour so apps
              without explicit bg/color match the device default (and Test
              Mode, which forces these in PreviewFrame). Without this, the
              black phone bezel shows through and Text nodes inherit the
              studio shell's dark-theme foreground, which vanishes on the
              first white-backed component the user adds. */}
          <div className="w-full h-full overflow-hidden rounded-[46px] bg-white text-black">
            <div
              ref={containerRef}
              className="w-full h-full relative"
            >
              {/* Overlay for loading state */}
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
                  <RefreshCw className="w-6 h-6 animate-spin text-zinc-400" />
                </div>
              )}
              {!engineReady && !loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 text-center p-4 text-sm z-10">
                  <p className="mb-2">{remoteUrl ? "Connecting to device..." : "Preview not ready"}</p>
                  <p className="text-xs text-zinc-500">
                    {remoteUrl ? "Waiting for remote engine connection" : "Open a .hypen file and click refresh"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
