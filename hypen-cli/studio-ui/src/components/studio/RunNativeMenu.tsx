/**
 * Top-toolbar "Run" menu. Two sections:
 *
 *   1. Running devices — the original native-runner flow: picks a booted
 *      device and runs `hypen run <platform>` against it. Shown first
 *      because "run this on my booted emulator/sim" is the common case.
 *   2. Custom scripts — user-defined `runScripts[]` in hypen.json. Each
 *      runs via WS stream, logs pipe to the Studio Console panel through
 *      a `hypen:console:log` window event. Footer: "+ New script" opens
 *      the RunScriptBuilder modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Rocket,
  Loader2,
  AlertCircle,
  Check,
  Plus,
  Play,
  FileCode2,
  Pencil,
  X,
} from "lucide-react";
import type { RunScript } from "./run-scripts-types";
import { RunScriptBuilder } from "./RunScriptBuilder";

type StudioDevice = {
  id: string;
  platform: "android" | "ios";
  name: string;
  status: "running" | "stopped" | "unknown";
  subtitle?: string;
};

function emitConsole(level: "info" | "warn" | "error", msg: string) {
  window.dispatchEvent(
    new CustomEvent("hypen:console:log", { detail: { level, msg } }),
  );
}

export function RunNativeMenu({ overrideUrl }: { overrideUrl?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLaunched, setLastLaunched] = useState<string | null>(null);
  const [devices, setDevices] = useState<StudioDevice[]>([]);
  const [scripts, setScripts] = useState<RunScript[]>([]);
  // null = builder closed; otherwise the script being edited ({} id=="" for new).
  const [builderScript, setBuilderScript] = useState<RunScript | null>(null);
  // Currently running custom script (id) — used to disable the row.
  const [runningScriptId, setRunningScriptId] = useState<string | null>(null);
  const [runningScriptStep, setRunningScriptStep] = useState<string>("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const openFromEvent = () => setOpen(true);
    window.addEventListener("hypen:run-menu:open", openFromEvent);
    return () => window.removeEventListener("hypen:run-menu:open", openFromEvent);
  }, []);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      const merged: StudioDevice[] = [...(body.android ?? []), ...(body.ios ?? [])]
        .filter((d) => d.status === "running");
      setDevices(merged);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadScripts = useCallback(async () => {
    try {
      const res = await fetch("/api/run-scripts");
      if (!res.ok) return;
      const body = await res.json();
      setScripts(Array.isArray(body.scripts) ? body.scripts : []);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    loadDevices();
    loadScripts();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        // Don't auto-close while the builder modal is up — its overlay
        // catches clicks outside the menu.
        if (builderScript == null) setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, loadDevices, loadScripts, builderScript]);

  const run = async (d: StudioDevice) => {
    setRunningId(d.id);
    setError(null);
    setLastLaunched(null);
    try {
      const res = await fetch(
        `/api/devices/${d.platform}/${encodeURIComponent(d.id)}/run-native`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wsUrl: overrideUrl || undefined }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `status ${res.status}`);
      }
      setLastLaunched(d.name);
      // Auto-open Test Mode in a new window with this device's mirror
      // pre-attached. Skip if we're already inside the test-mode page —
      // that page handles `?device=` itself, no need for a second window.
      if (typeof window !== "undefined" && window.location.pathname !== "/test-mode") {
        const qs = new URLSearchParams({ device: `${d.platform}:${d.id}` });
        window.open(`/test-mode?${qs.toString()}`, "_blank", "noopener,noreferrer");
      }
      setTimeout(() => setOpen(false), 1500);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunningId(null);
    }
  };

  const runScript = useCallback((script: RunScript) => {
    if (runningScriptId) return;
    setRunningScriptId(script.id);
    setRunningScriptStep(`step 1 of ${script.steps.length}`);
    setError(null);
    emitConsole("info", `▶ Running script: ${script.name}`);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/run-script`);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ scriptId: script.id }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "script-start":
            setRunningScriptStep(`0 / ${msg.totalSteps}`);
            break;
          case "step-start":
            setRunningScriptStep(`${msg.index + 1} / ${script.steps.length}: ${msg.step.type}`);
            emitConsole("info", `  [${msg.index + 1}] ${stepLabel(msg.step)}`);
            break;
          case "log":
            emitConsole(msg.level ?? "info", `    ${msg.msg}`);
            break;
          case "step-done":
            emitConsole("info", `  ✓ step ${msg.index + 1} done`);
            break;
          case "step-error":
            emitConsole("error", `  ✗ step ${msg.index + 1}: ${msg.msg}`);
            break;
          case "script-done":
            emitConsole("info", `✓ Script "${script.name}" complete`);
            break;
          case "script-error":
            emitConsole("error", `✗ Script "${script.name}" failed: ${msg.msg}`);
            setError(msg.msg);
            break;
        }
      } catch {
        // ignore malformed frames
      }
    });
    ws.addEventListener("close", () => {
      setRunningScriptId(null);
      setRunningScriptStep("");
    });
    ws.addEventListener("error", () => {
      emitConsole("error", "Run-script WebSocket error");
      setRunningScriptId(null);
      setRunningScriptStep("");
    });
  }, [runningScriptId]);

  const onSaveScript = useCallback(async (script: RunScript) => {
    // Load current config, splice the script in (by id), PUT back.
    const res = await fetch("/api/config");
    const current = res.ok ? await res.json() : {};
    const list: RunScript[] = Array.isArray(current.runScripts) ? current.runScripts : [];
    const idx = list.findIndex((s) => s.id === script.id);
    if (idx >= 0) list[idx] = script;
    else list.push(script);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, runScripts: list }),
    });
    setBuilderScript(null);
    loadScripts();
  }, [loadScripts]);

  const onDeleteScript = useCallback(async (id: string) => {
    const res = await fetch("/api/config");
    const current = res.ok ? await res.json() : {};
    const list: RunScript[] = Array.isArray(current.runScripts) ? current.runScripts : [];
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, runScripts: list.filter((s) => s.id !== id) }),
    });
    loadScripts();
  }, [loadScripts]);

  const newScript = useMemo<RunScript>(() => ({
    id: `script-${Date.now().toString(36)}`,
    name: "New script",
    steps: [{ type: "shell", cmd: "" }],
  }), []);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="gap-1.5"
        title="Install Hypen Runner and launch the app on a running device"
      >
        <Rocket className="w-4 h-4 text-[#FFA7E1]" />
        <span className="hidden sm:inline">Run</span>
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-80 rounded-md border border-border bg-popover shadow-lg z-50 overflow-hidden"
          role="menu"
        >
          {error && (
            <div className="px-3 py-2 text-[11px] text-red-300 bg-red-950/40 border-b border-border flex items-start gap-2">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="flex-1 break-words">{error}</span>
              <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {lastLaunched && (
            <div className="px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/30 border-b border-border flex items-center gap-2">
              <Check className="w-3 h-3" />
              Launched on {lastLaunched}.
            </div>
          )}

          {/* ── Running devices (Android / iOS) ── */}
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs font-medium">
            <Rocket className="w-3.5 h-3.5 text-[#FFA7E1]" />
            Run on a running device
            {loading && <Loader2 className="w-3 h-3 animate-spin ml-auto opacity-70" />}
          </div>
          <div className="max-h-52 overflow-y-auto">
            {!loading && devices.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">
                No running devices. Boot a simulator / emulator from Test Mode first.
              </div>
            )}
            {devices.map((d) => {
              const isRunning = runningId === d.id;
              return (
                <button
                  key={`${d.platform}:${d.id}`}
                  onClick={() => run(d)}
                  disabled={isRunning}
                  className={cn(
                    "w-full px-3 py-2 flex items-center gap-2 text-xs text-left hover:bg-muted/40",
                    isRunning && "cursor-wait opacity-70"
                  )}
                >
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">
                    {d.platform}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{d.name}</div>
                    {d.subtitle && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {d.subtitle}
                      </div>
                    )}
                  </div>
                  {isRunning
                    ? <Loader2 className="w-3 h-3 animate-spin text-[#FFA7E1]" />
                    : <Rocket className="w-3 h-3 text-[#FFA7E1]" />}
                </button>
              );
            })}
          </div>

          {/* ── Custom scripts (user-defined) ── */}
          <div className="px-3 py-2 border-t border-b border-border flex items-center gap-2 text-xs font-medium">
            <FileCode2 className="w-3.5 h-3.5 text-[#FFA7E1]" />
            Custom scripts
          </div>
          <div className="max-h-52 overflow-y-auto">
            {scripts.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">
                None defined. Add one below.
              </div>
            )}
            {scripts.map((s) => {
              const isRunning = runningScriptId === s.id;
              return (
                <div
                  key={s.id}
                  className="group w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/40"
                >
                  <button
                    className="flex-1 min-w-0 text-left flex flex-col"
                    onClick={() => runScript(s)}
                    disabled={isRunning || Boolean(runningScriptId)}
                    title="Run script"
                  >
                    <span className="truncate">{s.name}</span>
                    {isRunning && runningScriptStep && (
                      <span className="text-[10px] text-muted-foreground truncate">{runningScriptStep}</span>
                    )}
                    {!isRunning && (
                      <span className="text-[10px] text-muted-foreground truncate">
                        {s.steps.length} step{s.steps.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                  {isRunning
                    ? <Loader2 className="w-3 h-3 animate-spin text-[#FFA7E1]" />
                    : (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); runScript(s); }}
                          className="opacity-70 hover:opacity-100"
                          title="Run"
                          disabled={Boolean(runningScriptId)}
                        >
                          <Play className="w-3 h-3 text-[#FFA7E1]" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setBuilderScript(s); }}
                          className="opacity-70 hover:opacity-100"
                          title="Edit"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${s.name}"?`)) onDeleteScript(s.id); }}
                          className="opacity-70 hover:opacity-100"
                          title="Delete"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </>
                    )}
                </div>
              );
            })}
          </div>
          <button
            className="w-full px-3 py-2 text-[11px] border-t border-border hover:bg-muted/40 flex items-center gap-1.5 text-muted-foreground"
            onClick={() => setBuilderScript(newScript)}
          >
            <Plus className="w-3 h-3" />
            New custom script
          </button>
        </div>
      )}

      {builderScript && (
        <RunScriptBuilder
          initial={builderScript}
          onSave={onSaveScript}
          onCancel={() => setBuilderScript(null)}
        />
      )}
    </div>
  );
}

function stepLabel(step: any): string {
  switch (step?.type) {
    case "install-gallery": return `Install ${step.platform} gallery`;
    case "shell":           return `Shell: ${step.cmd?.slice(0, 60) ?? ""}`;
    case "open-in-gallery": return `Open in ${step.platform} gallery — ${step.url}`;
    case "hypen-run":       return `Hypen run (${step.platform})`;
    default:                return String(step?.type ?? "?");
  }
}
