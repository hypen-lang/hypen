import { useState, useEffect, useCallback, useRef } from "react";
import { FileTree } from "./FileTree";
import { EditorTabs } from "./EditorTabs";
import { Preview } from "./Preview";
import { BottomPanel } from "./BottomPanel";
import { Toolbar } from "./Toolbar";
import { CommandPalette } from "./CommandPalette";
import { ResizeHandle } from "./ResizeHandle";
import { TestMode } from "./TestMode";
import { cn } from "@/lib/utils";

export type PanelState = {
  files: boolean;
  preview: boolean;
  state: boolean;
  actions: boolean;
  console: boolean;
  timeline: boolean;
  terminal: boolean;
};

export type OpenFile = {
  path: string;
  content: string;
  modified: boolean;
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  ext?: string;
  children?: FileNode[];
};

export type ConsoleLog = {
  time: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type ActionLogEntry = {
  time: string;
  name: string;
  payload?: any;
};

export type StateHistoryEntry = {
  id: string;
  timestamp: number;
  action?: string;
  state: Record<string, any>;
};

export function Studio() {
  const [panels, setPanels] = useState<PanelState>({
    files: true,
    preview: true,
    state: false,
    actions: false,
    console: false,
    timeline: false,
    terminal: false,
  });

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newItem, setNewItem] = useState<{
    type: "file" | "folder";
    parentPath: string | null;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboardPath, setClipboardPath] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const [currentState, setCurrentState] = useState<Record<string, any>>({});
  const [stateHistory, setStateHistory] = useState<StateHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  // Track time-travel mode via ref so async callbacks always see current value.
  // True whenever historyIndex is behind the latest entry.
  const timeTravelRef = useRef(false);

  // Panel sizes
  const [fileTreeWidth, setFileTreeWidth] = useState(240);
  const [previewWidth, setPreviewWidth] = useState(384);
  const [bottomHeight, setBottomHeight] = useState(192);

  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

  const handleFileTreeResize = useCallback((delta: number) => {
    setFileTreeWidth((w) => clamp(w + delta, 160, 400));
  }, []);

  const handlePreviewResize = useCallback((delta: number) => {
    setPreviewWidth((w) => clamp(w - delta, 384, 600));
  }, []);

  const handleBottomResize = useCallback((delta: number) => {
    setBottomHeight((h) => clamp(h - delta, 100, 500));
  }, []);

  // Toggle panel
  const togglePanel = useCallback((panel: keyof PanelState) => {
    setPanels((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  // Add console log
  const addConsoleLog = useCallback((level: ConsoleLog["level"], message: string) => {
    setConsoleLogs((prev) => [
      { time: new Date().toLocaleTimeString(), level, message },
      ...prev.slice(0, 199),
    ]);
  }, []);

  // Bridge: any component can fire `hypen:console:log` to surface a line
  // in the Console panel without having to plumb addConsoleLog through.
  // RunNativeMenu uses this to stream run-script output.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { level?: ConsoleLog["level"]; msg?: string } | undefined;
      if (!detail) return;
      addConsoleLog(detail.level ?? "info", detail.msg ?? "");
    };
    window.addEventListener("hypen:console:log", onEvent);
    return () => window.removeEventListener("hypen:console:log", onEvent);
  }, [addConsoleLog]);

  // Load file tree
  const loadFileTree = useCallback(async () => {
    try {
      const res = await fetch("/api/files");
      const tree = await res.json();
      setFileTree(tree);
    } catch (e) {
      addConsoleLog("error", `Failed to load file tree: ${e}`);
    }
  }, [addConsoleLog]);

  // Track files being loaded to prevent duplicate requests
  const loadingFiles = useRef(new Set<string>());

  // Open file
  const openFile = useCallback(async (path: string) => {
    // Check if already open
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      setActiveFile(path);
      return;
    }

    // Check if already loading
    if (loadingFiles.current.has(path)) {
      return;
    }

    loadingFiles.current.add(path);

    try {
      const url = `/api/files/${encodeURIComponent(path)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        addConsoleLog("error", `Failed to open file: ${path} - ${data.error || res.statusText}`);
        return;
      }

      if (!data.content && data.content !== "") {
        addConsoleLog("error", `No content returned for: ${path}`);
        return;
      }

      setOpenFiles((prev) => {
        // Double-check not already added
        if (prev.find((f) => f.path === path)) {
          return prev;
        }
        return [...prev, { path, content: data.content, modified: false }];
      });
      setActiveFile(path);
      addConsoleLog("info", `Opened: ${path}`);
    } catch (e: any) {
      addConsoleLog("error", `Failed to open file: ${path} - ${e.message}`);
    } finally {
      loadingFiles.current.delete(path);
    }
  }, [openFiles, addConsoleLog]);

  // Close file
  const closeFile = useCallback((path: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (activeFile === path) {
      setActiveFile(openFiles.find((f) => f.path !== path)?.path || null);
    }
  }, [activeFile, openFiles]);

  // Debounced autosave. One timer per open file — per-file so editing file A
  // doesn't cancel a pending save for file B when the user swaps tabs mid-type.
  // The 300ms window matches the editor's feel: fast enough that pressing Cmd+R
  // rarely loses a keystroke, long enough to avoid hammering the filesystem on
  // every character. Saved content is pulled from the setOpenFiles updater
  // instead of closed-over state, so the latest value wins even if multiple
  // edits queue up during a render tick.
  const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scheduleAutoSave = useCallback((path: string) => {
    const existing = autoSaveTimers.current.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      autoSaveTimers.current.delete(path);
      let latest: string | null = null;
      setOpenFiles((prev) => {
        const f = prev.find((x) => x.path === path);
        latest = f?.content ?? null;
        return prev;
      });
      if (latest === null) return;
      try {
        const res = await fetch(`/api/files/${encodeURIComponent(path)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: latest }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        setOpenFiles((prev) =>
          prev.map((f) => (f.path === path ? { ...f, modified: false } : f))
        );
      } catch (e: any) {
        addConsoleLog("error", `Autosave failed for ${path}: ${e?.message ?? e}`);
      }
    }, 300);
    autoSaveTimers.current.set(path, timer);
  }, [addConsoleLog]);

  useEffect(() => {
    // Flush all pending timers on unmount so a save queued mid-type isn't lost.
    return () => {
      for (const t of autoSaveTimers.current.values()) clearTimeout(t);
      autoSaveTimers.current.clear();
    };
  }, []);

  // Update file content
  const updateFileContent = useCallback((path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content, modified: true } : f))
    );
    scheduleAutoSave(path);
  }, [scheduleAutoSave]);

  // Manual save (Cmd+S / explicit) — cancels any pending autosave for the file
  // and writes immediately.
  const saveFile = useCallback(async (path: string) => {
    const pending = autoSaveTimers.current.get(path);
    if (pending) {
      clearTimeout(pending);
      autoSaveTimers.current.delete(path);
    }
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;

    try {
      await fetch(`/api/files/${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: file.content }),
      });

      setOpenFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, modified: false } : f))
      );
      addConsoleLog("info", `Saved: ${path}`);
    } catch (e) {
      addConsoleLog("error", `Failed to save: ${path}`);
    }
  }, [openFiles, addConsoleLog]);

  // Create new file
  const createFile = useCallback(async (parentPath: string | null, name: string) => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });

      if (res.ok) {
        addConsoleLog("info", `Created: ${path}`);
        await loadFileTree();
        openFile(path);
      } else {
        const data = await res.json();
        addConsoleLog("error", `Failed to create file: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      addConsoleLog("error", `Failed to create file: ${e.message}`);
    }
  }, [addConsoleLog, loadFileTree, openFile]);

  // Create new folder
  const createFolder = useCallback(async (parentPath: string | null, name: string) => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}`, {
        method: "POST",
      });

      if (res.ok) {
        addConsoleLog("info", `Created folder: ${path}`);
        await loadFileTree();
      } else {
        const data = await res.json();
        addConsoleLog("error", `Failed to create folder: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      addConsoleLog("error", `Failed to create folder: ${e.message}`);
    }
  }, [addConsoleLog, loadFileTree]);

  // Handle inline create item
  const handleCreateItem = useCallback((name: string) => {
    if (!newItem) return;

    if (newItem.type === "file") {
      createFile(newItem.parentPath, name);
    } else {
      createFolder(newItem.parentPath, name);
    }

    setNewItem(null);
  }, [newItem, createFile, createFolder]);

  // Delete file or folder
  const deleteItem = useCallback(async (path: string) => {
    if (!path) return;

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(path)}`, {
        method: "DELETE",
      });

      if (res.ok) {
        addConsoleLog("info", `Deleted: ${path}`);
        await loadFileTree();
        // Close file if it was open
        closeFile(path);
        if (selectedPath === path) {
          setSelectedPath(null);
        }
      } else {
        const data = await res.json();
        addConsoleLog("error", `Failed to delete: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      addConsoleLog("error", `Failed to delete: ${e.message}`);
    }
  }, [addConsoleLog, loadFileTree, closeFile, selectedPath]);

  // Rename file or folder
  const renameItem = useCallback(async (oldPath: string, newName: string) => {
    if (!oldPath) return;

    const parentPath = oldPath.includes("/")
      ? oldPath.substring(0, oldPath.lastIndexOf("/"))
      : "";
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(oldPath)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPath }),
      });

      if (res.ok) {
        addConsoleLog("info", `Renamed: ${oldPath} -> ${newPath}`);
        await loadFileTree();
        // Update open files paths
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === oldPath ? { ...f, path: newPath } : f
          )
        );
        if (activeFile === oldPath) {
          setActiveFile(newPath);
        }
        if (selectedPath === oldPath) {
          setSelectedPath(newPath);
        }
      } else {
        const data = await res.json();
        addConsoleLog("error", `Failed to rename: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      addConsoleLog("error", `Failed to rename: ${e.message}`);
    }

    setRenamingPath(null);
  }, [addConsoleLog, loadFileTree, activeFile, selectedPath]);

  // Copy file/folder to clipboard
  const copyItem = useCallback((path: string) => {
    if (!path) return;
    setClipboardPath(path);
    addConsoleLog("info", `Copied to clipboard: ${path}`);
  }, [addConsoleLog]);

  // Paste from clipboard
  const pasteItem = useCallback(async (destinationPath: string | null) => {
    if (!clipboardPath) return;

    const sourceName = clipboardPath.includes("/")
      ? clipboardPath.substring(clipboardPath.lastIndexOf("/") + 1)
      : clipboardPath;
    const destPath = destinationPath
      ? `${destinationPath}/${sourceName}`
      : sourceName;

    try {
      const res = await fetch("/api/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: clipboardPath, destination: destPath }),
      });

      if (res.ok) {
        addConsoleLog("info", `Pasted: ${clipboardPath} -> ${destPath}`);
        await loadFileTree();
      } else {
        const data = await res.json();
        addConsoleLog("error", `Failed to paste: ${data.error || res.statusText}`);
      }
    } catch (e: any) {
      addConsoleLog("error", `Failed to paste: ${e.message}`);
    }
  }, [clipboardPath, addConsoleLog, loadFileTree]);

  // Connect WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      addConsoleLog("info", "Connected to Hypen Studio server");
    };

    ws.onclose = () => {
      setConnected(false);
      addConsoleLog("warn", "Disconnected from server");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "reload") {
          addConsoleLog("info", `File changed: ${data.file}`);
          loadFileTree();
        }
      } catch (e) {
        // ignore
      }
    };

    return () => ws.close();
  }, [addConsoleLog, loadFileTree]);

  // Load file tree on mount
  useEffect(() => {
    loadFileTree();
  }, [loadFileTree]);

  // Load session or entry file
  useEffect(() => {
    (async () => {
      try {
        // Check for teleported session first
        const sessionRes = await fetch("/api/session");
        const sessionData = await sessionRes.json();

        if (sessionData.success && sessionData.session) {
          const session = sessionData.session;
          addConsoleLog("info", `Loading teleported session: ${session.example}`);

          // Get project info
          const projectRes = await fetch("/api/project");
          const project = await projectRes.json();

          // Check for remote URL
          if (project.remoteUrl) {
            setRemoteUrl(project.remoteUrl);
          }

          // Create session files
          const hypenPath = `src/components/${project.entry}/component.hypen`;
          const modulePath = `src/components/${project.entry}/component.ts`;

          // Write the teleported files
          if (session.hypenCode) {
            await fetch(`/api/files/${encodeURIComponent(hypenPath)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: session.hypenCode }),
            });
          }

          if (session.moduleCode) {
            await fetch(`/api/files/${encodeURIComponent(modulePath)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: session.moduleCode }),
            });
          }

          // Reload file tree
          await loadFileTree();

          // Open the files
          await openFile(hypenPath);

          // Initialize state history from session
          if (session.stateHistory && session.stateHistory.length > 0) {
            setStateHistory(session.stateHistory.map((entry: any, idx: number) => ({
              id: entry.id || `teleport-${idx}`,
              timestamp: entry.ts || entry.timestamp || Date.now() - (session.stateHistory.length - idx) * 1000,
              action: entry.action,
              state: entry.state,
            })));
            setHistoryIndex(session.stateHistory.length - 1);
            setCurrentState(session.stateHistory[session.stateHistory.length - 1]?.state || session.state || {});
          } else if (session.state) {
            setCurrentState(session.state);
            setStateHistory([{
              id: "teleport-initial",
              timestamp: Date.now(),
              state: session.state,
            }]);
            setHistoryIndex(0);
          }

          // Open state/timeline panels if we have state history
          if (session.stateHistory?.length > 0 || session.state) {
            setPanels((prev) => ({ ...prev, state: true, timeline: true }));
          }

          addConsoleLog("info", `Session loaded successfully`);
          return;
        }

        // No session, load default entry file
        const projectRes = await fetch("/api/project");
        const project = await projectRes.json();

        // Check for remote URL (set when running with --studio)
        if (project.remoteUrl) {
          setRemoteUrl(project.remoteUrl);
        }

        const entryPath = `src/components/${project.entry}/component.hypen`;
        openFile(entryPath);
      } catch (e) {
        // ignore
      }
    })();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (e.key === "Escape") {
        setCommandPaletteOpen(false);
        return;
      }

      if (mod && e.key === "s" && !e.shiftKey) {
        e.preventDefault();
        if (activeFile) saveFile(activeFile);
        return;
      }

      if (mod && e.shiftKey && e.key === "s") {
        e.preventDefault();
        togglePanel("state");
        return;
      }

      if (mod && e.key === "b") {
        e.preventDefault();
        togglePanel("files");
        return;
      }

      if (mod && e.key === "j") {
        e.preventDefault();
        togglePanel("console");
        return;
      }

      if (mod && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        togglePanel("terminal");
        return;
      }

      if (mod && e.shiftKey && e.key === "t") {
        e.preventDefault();
        togglePanel("timeline");
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFile, saveFile, togglePanel]);

  const hasBottomPanel = panels.state || panels.actions || panels.console || panels.timeline || panels.terminal;

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden dark">
      <Toolbar
        panels={panels}
        togglePanel={togglePanel}
        connected={connected}
        testMode={testMode}
        onToggleTestMode={() => setTestMode((v) => !v)}
        onCommandPalette={() => setCommandPaletteOpen(true)}
      />

      {testMode && (
        <TestMode activeFile={activeFile} onClose={() => setTestMode(false)} />
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex overflow-hidden">
          {/* File Tree */}
          {panels.files && (
            <>
              <FileTree
                files={fileTree}
                activeFile={activeFile}
                selectedPath={selectedPath}
                clipboardPath={clipboardPath}
                newItem={newItem}
                renamingPath={renamingPath}
                style={{ width: fileTreeWidth }}
                onFileSelect={openFile}
                onPathSelect={(path, _isDirectory) => setSelectedPath(path)}
                onNewFile={(parentPath) => setNewItem({ type: "file", parentPath })}
                onNewFolder={(parentPath) => setNewItem({ type: "folder", parentPath })}
                onCreateItem={handleCreateItem}
                onCancelNewItem={() => setNewItem(null)}
                onCopy={copyItem}
                onPaste={pasteItem}
                onDelete={deleteItem}
                onRename={(path) => setRenamingPath(path)}
                onRenameSubmit={renameItem}
                onCancelRename={() => setRenamingPath(null)}
              />
              <ResizeHandle direction="vertical" onResize={handleFileTreeResize} />
            </>
          )}

          {/* Editor Area */}
          <div className="flex-1 flex flex-col min-w-0">
            <EditorTabs
              files={openFiles}
              activeFile={activeFile}
              onSelect={setActiveFile}
              onClose={closeFile}
              onContentChange={updateFileContent}
            />
          </div>

          {/* Preview */}
          {panels.preview && (
            <>
              <ResizeHandle direction="vertical" onResize={handlePreviewResize} />
              <Preview
                activeFile={activeFile}
                openFiles={openFiles}
                remoteUrl={remoteUrl}
                style={{ width: previewWidth }}
                overrideState={
                  timeTravelRef.current
                    ? stateHistory[historyIndex]?.state ?? null
                    : null
                }
                onLog={addConsoleLog}
                onActionLog={(name, payload) =>
                  setActionLog((prev) => [
                    { time: new Date().toLocaleTimeString(), name, payload },
                    ...prev.slice(0, 99),
                  ])
                }
                onStateChange={(state) => {
                  // Skip recording state changes caused by time-travel
                  if (timeTravelRef.current) return;
                  setCurrentState(state);
                  setStateHistory((prev) => {
                    const newHistory = [
                      ...prev,
                      {
                        id: `${Date.now()}`,
                        timestamp: Date.now(),
                        state,
                      },
                    ];
                    setHistoryIndex(newHistory.length - 1);
                    return newHistory;
                  });
                }}
              />
            </>
          )}
        </div>

        {/* Bottom Panels */}
        {hasBottomPanel && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleBottomResize} />
            <BottomPanel
              panels={panels}
              consoleLogs={consoleLogs}
              actionLog={actionLog}
              currentState={currentState}
              stateHistory={stateHistory}
              historyIndex={historyIndex}
              style={{ height: bottomHeight }}
              onHistoryChange={(index) => {
                const isAtLatest = index >= stateHistory.length - 1;
                timeTravelRef.current = !isAtLatest;
                setHistoryIndex(index);
                if (index >= 0 && index < stateHistory.length) {
                  setCurrentState(stateHistory[index].state);
                }
              }}
              onClearConsole={() => setConsoleLogs([])}
              onClearActions={() => setActionLog([])}
            />
          </>
        )}
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        panels={panels}
        togglePanel={togglePanel}
        onSave={() => activeFile && saveFile(activeFile)}
        onToggleTestMode={() => setTestMode((v) => !v)}
        onRun={() => window.dispatchEvent(new CustomEvent("hypen:run-menu:open"))}
      />

    </div>
  );
}
