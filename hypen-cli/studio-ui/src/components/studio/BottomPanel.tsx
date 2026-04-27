import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Trash2, Play, Plus, Zap } from "lucide-react";
import { useEffect, useState, useRef, useCallback } from "react";
import { JsonEditor } from "json-edit-react";
import type { PanelState, ConsoleLog, ActionLogEntry, StateHistoryEntry } from "./Studio";
import { TerminalPanel } from "./TerminalPanel";

interface MockInfo {
  active: boolean;
  state: Record<string, unknown>;
  refs: { statePaths: string[]; actionNames: string[] };
  arrayPaths: string[];
}

type BottomPanelProps = {
  panels: PanelState;
  consoleLogs: ConsoleLog[];
  actionLog: ActionLogEntry[];
  currentState: Record<string, any>;
  stateHistory: StateHistoryEntry[];
  historyIndex: number;
  style?: React.CSSProperties;
  onHistoryChange: (index: number) => void;
  onClearConsole: () => void;
  onClearActions: () => void;
};

/**
 * State panel. Two modes:
 *   - Mock active (entry has no .ts module): editable JSON tree via
 *     json-edit-react, with "+ row" buttons for arrays and "fire" buttons
 *     for each discovered @actions.* name. Every edit streams to the
 *     studio-hosted engine via POST /api/engine/mock/state, which pushes
 *     updateState into every live session.
 *   - Real module: read-only JSON view of whatever state the module has
 *     produced so far. Editing doesn't make sense here because the
 *     module owns mutations.
 */
function StatePanel({ state }: { state: Record<string, any> }) {
  const [mock, setMock] = useState<MockInfo | null>(null);
  const [pending, setPending] = useState(false);
  // Track local edits separately from the fetched state so we don't clobber
  // the user's typing if the engine pushes a refresh mid-edit.
  const [localState, setLocalState] = useState<Record<string, unknown> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshMock = useCallback(async () => {
    try {
      const res = await fetch("/api/engine/mock");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as MockInfo;
      setMock(body);
      if (body.active && localState == null) setLocalState(body.state);
    } catch { /* engine not ready yet */ }
  }, [localState]);

  useEffect(() => {
    refreshMock();
    const id = setInterval(refreshMock, 4000);
    return () => clearInterval(id);
  }, [refreshMock]);

  const scheduleSave = useCallback((next: Record<string, unknown>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;
      setPending(true);
      try {
        await fetch("/api/engine/mock/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
      } finally {
        setPending(false);
      }
    }, 200);
  }, []);

  const addRow = useCallback(async (path: string) => {
    await fetch("/api/engine/mock/add-row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    refreshMock();
  }, [refreshMock]);

  const fireAction = useCallback(async (name: string) => {
    await fetch("/api/engine/mock/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }, []);

  // ── Mock mode: editable tree + action buttons ──
  if (mock?.active) {
    const tree = localState ?? mock.state;
    return (
      <div className="flex flex-col h-full font-mono text-xs">
        <div className="px-3 py-2 border-b border-border bg-muted/20 text-[11px] text-muted-foreground flex items-center gap-2">
          <span>
            Mock mode — {mock.refs.statePaths.length} state, {mock.refs.actionNames.length} action
            {mock.refs.actionNames.length === 1 ? "" : "s"}
          </span>
          {pending && <span className="text-[#FFA7E1]">saving…</span>}
        </div>
        <div className="flex-1 overflow-auto p-2">
          <JsonEditor
            data={tree}
            setData={(next) => {
              const obj = next as Record<string, unknown>;
              setLocalState(obj);
              scheduleSave(obj);
            }}
            theme="githubDark"
            rootName="state"
            collapse={2}
            restrictAdd={false}
            restrictDelete={false}
            enableClipboard={false}
            minWidth="100%"
            maxWidth="100%"
          />
          {mock.arrayPaths.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Array rows
              </div>
              <div className="flex flex-wrap gap-1">
                {mock.arrayPaths.map((p) => (
                  <Button
                    key={p}
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] gap-1 font-mono"
                    onClick={() => addRow(p)}
                    title={`Append a row to state.${p}`}
                  >
                    <Plus className="w-3 h-3" />
                    {p}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {mock.refs.actionNames.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Actions
              </div>
              <div className="flex flex-wrap gap-1">
                {mock.refs.actionNames.map((name) => (
                  <Button
                    key={name}
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] gap-1 font-mono"
                    onClick={() => fireAction(name)}
                    title={`Dispatch @actions.${name}`}
                  >
                    <Zap className="w-3 h-3" />
                    {name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Real module: read-only pretty-print ──
  return (
    <div className="p-3 font-mono text-xs overflow-auto h-full">
      <pre className="text-foreground/80">{JSON.stringify(state, null, 2)}</pre>
    </div>
  );
}

function ActionsPanel({
  actions,
  onClear,
}: {
  actions: ActionLogEntry[];
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">{actions.length} actions</span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {actions.map((action, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 border-b border-border/50 text-sm"
          >
            <span className="text-muted-foreground text-xs font-mono">{action.time}</span>
            <span className="text-pink-400 font-medium">{action.name}</span>
            {action.payload && (
              <span className="text-muted-foreground font-mono text-xs truncate">
                {JSON.stringify(action.payload)}
              </span>
            )}
          </div>
        ))}
        {actions.length === 0 && (
          <div className="p-4 text-center text-muted-foreground text-sm">
            No actions dispatched yet
          </div>
        )}
      </div>
    </div>
  );
}

function ConsolePanel({
  logs,
  onClear,
}: {
  logs: ConsoleLog[];
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">{logs.length} logs</span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs">
        {logs.map((log, i) => (
          <div
            key={i}
            className={cn(
              "flex gap-2 px-3 py-1.5 border-l-2",
              log.level === "error" && "border-l-red-500 bg-red-500/10",
              log.level === "warn" && "border-l-yellow-500 bg-yellow-500/10",
              log.level === "info" && "border-l-blue-500/50"
            )}
          >
            <span className="text-muted-foreground shrink-0">{log.time}</span>
            <span
              className={cn(
                log.level === "error" && "text-red-400",
                log.level === "warn" && "text-yellow-400",
                log.level === "info" && "text-foreground/80"
              )}
            >
              {log.message}
            </span>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="p-4 text-center text-muted-foreground">No logs</div>
        )}
      </div>
    </div>
  );
}

function TimelinePanel({
  history,
  currentIndex,
  onChange,
}: {
  history: StateHistoryEntry[];
  currentIndex: number;
  onChange: (index: number) => void;
}) {
  const isTimeTraveling = currentIndex < history.length - 1 && currentIndex >= 0;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {history.length} states • {currentIndex + 1} / {history.length}
        </span>
        {isTimeTraveling && (
          <span className="text-xs px-2 py-0.5 rounded bg-pink-500/20 text-pink-400 border border-pink-500/30">
            Time Travel
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(history.length - 1)}
          disabled={history.length === 0}
        >
          <Play className="w-3 h-3 mr-1" /> Go Live
        </Button>
      </div>

      <input
        type="range"
        min={0}
        max={Math.max(0, history.length - 1)}
        value={Math.min(currentIndex, history.length - 1)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-pink-500"
        disabled={history.length === 0}
      />

      <div className="flex-1 overflow-auto max-h-32">
        {history.slice(-20).map((entry, i) => {
          const actualIndex = history.length - 20 + i;
          if (actualIndex < 0) return null;
          const isActive = actualIndex === currentIndex;

          return (
            <button
              key={entry.id}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded text-xs",
                "hover:bg-accent/50 transition-colors",
                isActive && "bg-pink-500/20 border border-pink-500/30"
              )}
              onClick={() => onChange(actualIndex)}
            >
              <span className="text-muted-foreground">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              {entry.action && (
                <span className="ml-2 text-pink-400">{entry.action}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BottomPanel({
  panels,
  consoleLogs,
  actionLog,
  currentState,
  stateHistory,
  historyIndex,
  onHistoryChange,
  onClearConsole,
  onClearActions,
  style,
}: BottomPanelProps) {
  const visiblePanels = [
    panels.state && "state",
    panels.actions && "actions",
    panels.console && "console",
    panels.timeline && "timeline",
    panels.terminal && "terminal",
  ].filter(Boolean);

  return (
    <div className="border-t border-border bg-card/50 flex" style={style}>
      {panels.state && (
        <div className="flex-1 border-r border-border flex flex-col">
          <div className="h-8 border-b border-border flex items-center px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              State
            </span>
          </div>
          <div className="flex-1 overflow-auto">
            <StatePanel state={currentState} />
          </div>
        </div>
      )}

      {panels.actions && (
        <div className="flex-1 border-r border-border flex flex-col">
          <div className="h-8 border-b border-border flex items-center px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Actions
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <ActionsPanel actions={actionLog} onClear={onClearActions} />
          </div>
        </div>
      )}

      {panels.console && (
        <div className="flex-1 border-r border-border flex flex-col">
          <div className="h-8 border-b border-border flex items-center px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Console
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <ConsolePanel logs={consoleLogs} onClear={onClearConsole} />
          </div>
        </div>
      )}

      {panels.timeline && (
        <div className="flex-1 flex flex-col">
          <div className="h-8 border-b border-border flex items-center px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Timeline
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <TimelinePanel
              history={stateHistory}
              currentIndex={historyIndex}
              onChange={onHistoryChange}
            />
          </div>
        </div>
      )}

      {panels.terminal && (
        <div className="flex-[2] flex flex-col min-w-0">
          <div className="h-8 border-b border-border flex items-center px-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Terminal
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <TerminalPanel />
          </div>
        </div>
      )}
    </div>
  );
}
