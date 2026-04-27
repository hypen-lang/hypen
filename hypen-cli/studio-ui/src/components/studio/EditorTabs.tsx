import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { X, FileCode } from "lucide-react";
import type { OpenFile } from "./Studio";
import { HypenLspClient } from "@/lib/lsp-client";

type EditorTabsProps = {
  files: OpenFile[];
  activeFile: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
};

// Monaco editor component
function MonacoEditor({
  file,
  onChange,
  lspClient,
  projectDir,
}: {
  file: OpenFile;
  onChange: (content: string) => void;
  lspClient: HypenLspClient | null;
  projectDir: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const lspRef = useRef(lspClient);
  lspRef.current = lspClient;
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [monaco, setMonaco] = useState<any>(null);

  // Load Monaco
  useEffect(() => {
    const loadMonaco = async () => {
      // @ts-ignore - Check if Monaco is already loaded
      if (window.monaco) {
        // @ts-ignore
        setMonaco(window.monaco);
        return;
      }

      // @ts-ignore - Check if loader is already loading
      if (window.__monacoLoading) {
        // Wait for it to finish
        const checkLoaded = setInterval(() => {
          // @ts-ignore
          if (window.monaco) {
            clearInterval(checkLoaded);
            // @ts-ignore
            setMonaco(window.monaco);
          }
        }, 100);
        return;
      }

      // @ts-ignore - Check if loader script already exists
      const existingScript = document.querySelector('script[src*="monaco-editor"]');
      if (existingScript) {
        // Wait for monaco to be available
        const checkLoaded = setInterval(() => {
          // @ts-ignore
          if (window.monaco) {
            clearInterval(checkLoaded);
            // @ts-ignore
            setMonaco(window.monaco);
          }
        }, 100);
        return;
      }

      // @ts-ignore
      window.__monacoLoading = true;

      // Load Monaco from CDN
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js";
      script.onload = () => {
        // @ts-ignore
        window.require.config({
          paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" },
        });
        // @ts-ignore
        window.require(["vs/editor/editor.main"], (monaco: any) => {
          // @ts-ignore
          window.monaco = monaco;
          // @ts-ignore
          window.__monacoLoading = false;

          // Define Hypen language (only if not already registered)
          if (!monaco.languages.getLanguages().some((l: any) => l.id === "hypen")) {
            monaco.languages.register({ id: "hypen" });
            monaco.languages.setMonarchTokensProvider("hypen", {
              keywords: ["module", "component", "true", "false"],
              tokenizer: {
                root: [
                  [/\/\/.*$/, "comment"],
                  [/"([^"\\]|\\.)*$/, "string.invalid"],
                  [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
                  [/\$\{[^}]+\}/, "variable"],
                  [/@(state|actions)\.[a-zA-Z_]\w*/, "variable.predefined"],
                  [/@(state|actions)/, "variable.predefined"],
                  [/\.([a-zA-Z]\w*)/, "function"],
                  [/[A-Z][a-zA-Z0-9]*/, "type.identifier"],
                  [/\b(module|component|true|false)\b/, "keyword"],
                  [/\d+(\.\d+)?/, "number"],
                  [/[{}()\[\]]/, "@brackets"],
                  [/[,:]/, "delimiter"],
                ],
                string: [
                  [/\$\{[^}]+\}/, "variable"],
                  [/[^\\"$]+/, "string"],
                  [/\\./, "string.escape"],
                  [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
                ],
              },
            });
          }

          // Define dark theme
          monaco.editor.defineTheme("hypen-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [
              { token: "type.identifier", foreground: "FFA7E1" },
              { token: "function", foreground: "FFECA7" },
              { token: "variable", foreground: "6bff9d" },
              { token: "variable.predefined", foreground: "6b9dff" },
              { token: "string", foreground: "ce9178" },
              { token: "keyword", foreground: "c586c0" },
              { token: "comment", foreground: "6a9955" },
            ],
            colors: {
              "editor.background": "#1a1a1a",
              "editor.lineHighlightBackground": "#252525",
              "editorLineNumber.foreground": "#555555",
              "editorCursor.foreground": "#FFA7E1",
            },
          });

          setMonaco(monaco);
        });
      };
      document.head.appendChild(script);
    };

    loadMonaco();
  }, []);

  // Create/update editor
  useEffect(() => {
    if (!monaco || !containerRef.current || !projectDir) return;

    if (!editorRef.current) {
      const ext = file.path.split(".").pop();
      const language = ext === "hypen" ? "hypen" : ext === "ts" || ext === "tsx" ? "typescript" : "javascript";

      // Create or reuse model with file:// URI so it matches LSP document URIs
      const modelUri = monaco.Uri.parse(`file://${projectDir}/${file.path}`);
      let model = monaco.editor.getModel(modelUri);
      if (!model) {
        model = monaco.editor.createModel(file.content, language, modelUri);
      } else if (model.getValue() !== file.content) {
        model.setValue(file.content);
      }

      editorRef.current = monaco.editor.create(containerRef.current, {
        model,
        theme: "hypen-dark",
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "on",
        padding: { top: 12 },
      });

      editorRef.current.onDidChangeModelContent(() => {
        const content = editorRef.current.getValue();
        onChange(content);

        // Debounced LSP sync for .hypen files
        if (lspRef.current?.isConnected && file.path.endsWith(".hypen")) {
          if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
          changeTimerRef.current = setTimeout(() => {
            lspRef.current?.changeDocument(file.path, content);
          }, 150);
        }
      });
    } else {
      // Update content if file changed externally
      if (editorRef.current.getValue() !== file.content) {
        editorRef.current.setValue(file.content);
      }
    }

    return () => {
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      if (editorRef.current) {
        // Snapshot the latest content so the extra lib stays current
        // after the editor is destroyed (model persists for LSP, but
        // if it were ever disposed the extra lib acts as fallback).
        const lastContent = editorRef.current.getValue();
        const uri = `file://${projectDir}/${file.path}`;
        if (lastContent && (file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) {
          monaco.languages.typescript.typescriptDefaults.addExtraLib(lastContent, uri);
        }
        editorRef.current.dispose();
        editorRef.current = null;
        // Model is NOT disposed here — it persists for LSP diagnostics
      }
    };
  }, [monaco, file.path, projectDir]);

  if (!monaco || !projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading editor...
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}

export function EditorTabs({
  files,
  activeFile,
  onSelect,
  onClose,
  onContentChange,
}: EditorTabsProps) {
  const activeFileData = files.find((f) => f.path === activeFile);
  const lspClientRef = useRef<HypenLspClient | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [lspReady, setLspReady] = useState(false);
  const openLspDocsRef = useRef<Set<string>>(new Set());

  // LSP client lifecycle
  useEffect(() => {
    let disposed = false;

    (async () => {
      // Wait for Monaco to load
      // @ts-ignore
      while (!window.monaco && !disposed) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (disposed) return;

      try {
        const res = await fetch("/api/project");
        const data = await res.json();
        if (disposed) return;
        setProjectDir(data.cwd);

        // @ts-ignore
        const monaco = window.monaco;
        const client = new HypenLspClient(data.cwd);
        lspClientRef.current = client;
        client.registerMonacoProviders(monaco);

        // Re-open all .hypen documents after an automatic reconnect
        client.onReconnect(() => {
          openLspDocsRef.current.clear();
          for (const file of filesRef.current) {
            if (file.path.endsWith(".hypen")) {
              client.openDocument(file.path, file.content, "hypen");
              openLspDocsRef.current.add(file.path);
            }
          }
          console.log("[Studio] LSP reconnected — documents re-synced");
        });

        await client.connect();

        if (disposed) {
          client.disconnect();
          return;
        }

        console.log("[Studio] LSP client connected");
        setLspReady(true);
      } catch (e) {
        console.warn("[Studio] LSP client setup failed:", e);
      }
    })();

    return () => {
      disposed = true;
      if (lspClientRef.current) {
        lspClientRef.current.disconnect();
        lspClientRef.current = null;
      }
      openLspDocsRef.current.clear();
    };
  }, []);

  // Sync open .hypen files with LSP
  useEffect(() => {
    const client = lspClientRef.current;
    if (!lspReady || !client?.isConnected) return;

    const currentPaths = new Set(
      files.filter((f) => f.path.endsWith(".hypen")).map((f) => f.path)
    );
    const previousPaths = openLspDocsRef.current;

    // Open newly added files
    for (const file of files) {
      if (file.path.endsWith(".hypen") && !previousPaths.has(file.path)) {
        client.openDocument(file.path, file.content, "hypen");
      }
    }

    // Close removed files and dispose their Monaco models
    for (const path of previousPaths) {
      if (!currentPaths.has(path)) {
        client.closeDocument(path);
        // @ts-ignore
        if (window.monaco && projectDir) {
          // @ts-ignore
          const uri = window.monaco.Uri.parse(`file://${projectDir}/${path}`);
          // @ts-ignore
          const model = window.monaco.editor.getModel(uri);
          if (model) model.dispose();
        }
      }
    }

    openLspDocsRef.current = currentPaths;
  }, [files, projectDir, lspReady]);

  // Configure Monaco's TypeScript environment so imports resolve correctly
  useEffect(() => {
    // @ts-ignore
    const m = window.monaco;
    if (!m || !projectDir) return;

    const ts = m.languages.typescript;

    // Use Bundler resolution (100) if available, fall back to NodeJs (2)
    const bundlerValue = 100;
    const moduleResolution =
      ts.ModuleResolutionKind?.Bundler ?? bundlerValue;

    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      allowNonTsExtensions: true,
      jsx: ts.JsxEmit.ReactJSX,
    });

    // Track disposables so we can clean up on re-run
    const libDisposables: { dispose(): void }[] = [];
    let cancelled = false;

    function addLib(content: string, uri: string) {
      const d = ts.typescriptDefaults.addExtraLib(content, uri);
      if (d) libDisposables.push(d);
    }

    (async () => {
      // 1. Load all project .ts files as extra libs so relative imports resolve
      try {
        const treeRes = await fetch("/api/files");
        const tree = await treeRes.json();

        const tsFiles: string[] = [];
        function collectTsFiles(nodes: any[]) {
          for (const node of nodes) {
            if (node.type === "file" && (node.ext === ".ts" || node.ext === ".tsx")) {
              tsFiles.push(node.path);
            }
            if (node.children) collectTsFiles(node.children);
          }
        }
        collectTsFiles(tree);

        // Fetch project files in parallel (batches of 10)
        for (let i = 0; i < tsFiles.length && !cancelled; i += 10) {
          const batch = tsFiles.slice(i, i + 10);
          const results = await Promise.all(
            batch.map(async (filePath) => {
              const uri = `file://${projectDir}/${filePath}`;
              if (m.editor.getModel(m.Uri.parse(uri))) return null;
              try {
                const res = await fetch(`/api/files/${encodeURIComponent(filePath)}`);
                if (res.ok) {
                  const data = await res.json();
                  if (data.content) return { uri, content: data.content };
                }
              } catch (e: any) {
                console.warn(`[Studio] Failed to fetch project file ${filePath}: ${e.message}`);
              }
              return null;
            })
          );
          for (const r of results) {
            if (r) addLib(r.content, r.uri);
          }
        }
      } catch (e: any) {
        console.warn(`[Studio] Failed to load project TypeScript files: ${e.message}`);
      }

      if (cancelled) return;

      // 2. Load npm package type declarations
      let packageNames: string[] = [];
      try {
        const pkgRes = await fetch("/api/files/package.json");
        if (pkgRes.ok) {
          const pkgData = await pkgRes.json();
          const pkg = JSON.parse(pkgData.content);
          packageNames = [
            ...Object.keys(pkg.dependencies || {}),
            ...Object.keys(pkg.devDependencies || {}),
          ];
        }
      } catch (e: any) {
        console.warn(`[Studio] Failed to load package.json: ${e.message}`);
      }

      for (const packageName of packageNames) {
        if (cancelled) return;
        try {
          const pkgRes = await fetch(`/node_modules/${packageName}/package.json`);
          if (!pkgRes.ok) continue;
          const pkgText = await pkgRes.text();
          const pkgJson = JSON.parse(pkgText);

          if (!pkgJson.types && !pkgJson.typings && !pkgJson.exports) continue;

          addLib(pkgText, `file://${projectDir}/node_modules/${packageName}/package.json`);

          const typesRes = await fetch(`/api/package-types/${encodeURIComponent(packageName)}`);
          if (!typesRes.ok) continue;
          const { results } = await typesRes.json();

          // Fetch .d.ts files in parallel (batches of 10)
          for (const { dir, files: dtsFiles } of results) {
            for (let i = 0; i < dtsFiles.length && !cancelled; i += 10) {
              const batch = dtsFiles.slice(i, i + 10);
              const fetched = await Promise.all(
                batch.map(async (dtsFile: string) => {
                  try {
                    const filePath = dir === "." ? dtsFile : `${dir}/${dtsFile}`;
                    const dtsRes = await fetch(
                      `/node_modules/${packageName}/${filePath}`
                    );
                    if (dtsRes.ok) {
                      return { filePath, content: await dtsRes.text() };
                    }
                  } catch (e: any) {
                    console.warn(`[Studio] Failed to fetch .d.ts file ${dtsFile}: ${e.message}`);
                  }
                  return null;
                })
              );
              for (const r of fetched) {
                if (!r) continue;
                const basePath = `file://${projectDir}/node_modules/${packageName}/${r.filePath}`;
                addLib(r.content, basePath);
                // Also register with .js path so "from ./foo.js" resolves
                if (r.filePath.endsWith(".d.ts")) {
                  addLib(r.content, basePath.replace(/\.d\.ts$/, ".js"));
                }
              }
            }
          }
        } catch (e: any) {
          console.warn(`[Studio] Failed to load types for ${packageName}: ${e.message}`);
        }
      }

      if (!cancelled) {
        console.log("[Studio] TypeScript environment configured");
      }
    })();

    return () => {
      cancelled = true;
      for (const d of libDisposables) d.dispose();
    };
  }, [projectDir]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tabs */}
      <div className="h-10 border-b border-border flex items-center overflow-x-auto bg-card/30">
        {files.map((file) => {
          const name = file.path.split("/").pop();
          const isActive = file.path === activeFile;

          return (
            <div
              key={file.path}
              className={cn(
                "h-full flex items-center gap-2 px-3 border-r border-border text-sm cursor-pointer",
                "hover:bg-accent/50 transition-colors",
                isActive && "bg-background border-b-2 border-b-pink-500"
              )}
              onClick={() => onSelect(file.path)}
            >
              <FileCode className="w-4 h-4 text-pink-400" />
              <span className={cn(file.modified && "italic")}>
                {file.modified && "• "}
                {name}
              </span>
              <span
                className="hover:bg-accent rounded p-0.5 cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(file.path);
                }}
              >
                <X className="w-3 h-3" />
              </span>
            </div>
          );
        })}
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0 bg-[#1a1a1a] overflow-hidden">
        {activeFileData ? (
          <div className="h-full w-full">
            <MonacoEditor
              key={activeFileData.path}
              file={activeFileData}
              onChange={(content) => onContentChange(activeFileData.path, content)}
              lspClient={lspClientRef.current}
              projectDir={projectDir}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            No file open
          </div>
        )}
      </div>
    </div>
  );
}
