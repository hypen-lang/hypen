/**
 * Test Mode — a full-screen overlay that tiles multiple previews side-by-side:
 *   - Web (DOM)  — iframe → /preview-frame?renderer=dom
 *   - Web (Canvas) — iframe → /preview-frame?renderer=canvas
 *   - iOS simulators — <img> pulling MJPEG from @hypen-space/ios-streamer
 *   - Android emulators / devices — <img> pulling MJPEG from studio
 *
 * A left sidebar lists all detected devices with run/stop controls.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AndroidWebRTCCell } from "./AndroidWebRTCCell";
import {
  X,
  Play,
  Square,
  RefreshCw,
  RotateCcw,
  Monitor,
  Palette,
  Smartphone,
  Apple,
  Bot,
  AlertCircle,
  ExternalLink,
  ScrollText,
  Loader2,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
} from "lucide-react";
import { DeviceLogs } from "./DeviceLogs";
import { RunNativeMenu } from "./RunNativeMenu";
import { ResizeHandle } from "./ResizeHandle";

const CELL_WEIGHTS_STORAGE_KEY = "hypen.testmode.cellWeights";
const MIN_CELL_WEIGHT = 0.15; // each cell keeps at least ~15% of total width

function loadStoredWeights(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CELL_WEIGHTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistWeights(weights: Record<string, number>): void {
  try {
    localStorage.setItem(CELL_WEIGHTS_STORAGE_KEY, JSON.stringify(weights));
  } catch {
    /* storage unavailable */
  }
}

type StudioDevice = {
  id: string;
  platform: "android" | "ios";
  name: string;
  status: "running" | "stopped" | "unknown";
  streamUrl: string | null;
  videoUrl?: string | null;
  webrtcUrl?: string | null;
  subtitle?: string;
};

type DevicesResponse = {
  android: StudioDevice[];
  ios: StudioDevice[];
  iosStreamer: boolean;
  iosReachable: boolean;
  iosFfmpeg: boolean;
  iosDiagnostic?: string;
};

type CellId = string;

type Cell =
  | { kind: "web-dom" }
  | { kind: "web-canvas" }
  | { kind: "device"; device: StudioDevice };

function cellKey(cell: Cell): CellId {
  if (cell.kind === "device") return `${cell.device.platform}:${cell.device.id}`;
  return cell.kind;
}

function cellTitle(cell: Cell): string {
  if (cell.kind === "web-dom") return "Web • DOM";
  if (cell.kind === "web-canvas") return "Web • Canvas";
  return `${cell.device.platform === "ios" ? "iOS" : "Android"} • ${cell.device.name}`;
}

export interface TestModeProps {
  activeFile: string | null;
  onClose: () => void;
}

export function TestMode({ activeFile, onClose }: TestModeProps) {
  const [devices, setDevices] = useState<DevicesResponse>({
    android: [],
    ios: [],
    iosStreamer: false,
    iosReachable: false,
    iosFfmpeg: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cells currently displayed. Web DOM is on by default if we have a file open.
  const [cells, setCells] = useState<Cell[]>(() =>
    activeFile && activeFile.endsWith(".hypen") ? [{ kind: "web-dom" }] : []
  );
  const [logsOpen, setLogsOpen] = useState(false);
  // Track devices mid-transition so we can show a yellow spinner between the
  // click and the next refresh that reports the new status.
  const [bootingIds, setBootingIds] = useState<Set<string>>(new Set());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [runningNative, setRunningNative] = useState<string | null>(null);
  // Optional dev-server URL that web previews connect to via RemoteEngine
  // and that the Run button uses as the runner deep link.
  //
  // `remoteUrl` is the *active* connection target (used by cells + Run).
  // `remoteUrlDraft` is what's in the input box — only promoted to `remoteUrl`
  // when the user explicitly submits (Enter or the Connect button).
  //
  // We don't auto-populate `remoteUrl` from localStorage: a remembered URL
  // from a previous session caused every cell to try connecting to a dead
  // port on fresh studio launches. The *last-used* value is still recalled
  // into the input so the user can one-click reconnect.
  const [remoteUrl, setRemoteUrlState] = useState<string>("");
  const [remoteUrlDraft, setRemoteUrlDraft] = useState<string>(() => {
    try { return localStorage.getItem("hypen.testmode.remoteUrl") ?? ""; } catch { return ""; }
  });
  const setRemoteUrl = useCallback((v: string) => {
    setRemoteUrlState(v);
    try { localStorage.setItem("hypen.testmode.remoteUrl", v); } catch { /* storage unavailable */ }
  }, []);
  const submitRemoteUrl = useCallback(() => {
    setRemoteUrl(remoteUrlDraft.trim());
  }, [remoteUrlDraft, setRemoteUrl]);
  const disconnectRemote = useCallback(() => {
    setRemoteUrlState("");
  }, []);

  // Collapsed-sidebar preference persists across reloads.
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem("hypen.testmode.sidebar.collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsedState((v) => {
      const next = !v;
      try { localStorage.setItem("hypen.testmode.sidebar.collapsed", next ? "1" : "0"); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  const refreshDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as DevicesResponse;
      setDevices(body);
      // Any device that's now "running" has finished booting; clear the marker.
      const runningIds = new Set(
        [...body.android, ...body.ios].filter((d) => d.status === "running").map((d) => d.id)
      );
      setBootingIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of prev) if (runningIds.has(id)) next.delete(id);
        return next.size === prev.size ? prev : next;
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 4000);
    return () => clearInterval(t);
  }, [refreshDevices]);

  // `?device=<platform>:<id>` (passed by RunNativeMenu after a successful
  // launch) auto-attaches that device cell as soon as the device shows up
  // in the next /api/devices snapshot. Stays as a one-shot — once added,
  // we don't keep re-adding it on subsequent refreshes.
  const requestedDeviceKey = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("device");
  }, []);
  const requestedDeviceAddedRef = useRef(false);
  useEffect(() => {
    if (!requestedDeviceKey || requestedDeviceAddedRef.current) return;
    const [platform, ...idParts] = requestedDeviceKey.split(":");
    const id = idParts.join(":");
    if (platform !== "android" && platform !== "ios") return;
    const pool = platform === "android" ? devices.android : devices.ios;
    const found = pool.find((d) => d.id === id);
    if (!found) return;
    requestedDeviceAddedRef.current = true;
    setCells((prev) => {
      const key = `${platform}:${id}`;
      if (prev.some((c) => cellKey(c) === key)) return prev;
      return [...prev, { kind: "device", device: found }];
    });
  }, [requestedDeviceKey, devices]);

  const toggleCell = useCallback((cell: Cell) => {
    setCells((prev) => {
      const key = cellKey(cell);
      if (prev.some((c) => cellKey(c) === key)) {
        return prev.filter((c) => cellKey(c) !== key);
      }
      return [...prev, cell];
    });
  }, []);

  const removeCell = useCallback((key: CellId) => {
    setCells((prev) => prev.filter((c) => cellKey(c) !== key));
  }, []);

  const markBooting = (id: string, booting: boolean) => {
    setBootingIds((prev) => {
      const next = new Set(prev);
      if (booting) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const markStopping = (id: string, stopping: boolean) => {
    setStoppingIds((prev) => {
      const next = new Set(prev);
      if (stopping) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const bootDevice = useCallback(async (d: StudioDevice) => {
    markBooting(d.id, true);
    try {
      const res = await fetch(
        `/api/devices/${d.platform}/${encodeURIComponent(d.id)}/boot`,
        { method: "POST" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any)?.message ?? (body as any)?.error ?? `status ${res.status}`);
      }
      // Keep the yellow spinner until the next refresh actually reports
      // the device as running (simctl/adb are slow to reflect state).
      const deadline = Date.now() + 90_000;
      const tick = async () => {
        if (Date.now() > deadline) {
          markBooting(d.id, false);
          return;
        }
        setTimeout(tick, 2000);
      };
      setTimeout(tick, 1500);
    } catch (e: any) {
      markBooting(d.id, false);
      setError(e?.message ?? String(e));
    }
  }, []);

  const stopDevice = useCallback(async (d: StudioDevice) => {
    markStopping(d.id, true);
    try {
      const res = await fetch(
        `/api/devices/${d.platform}/${encodeURIComponent(d.id)}/shutdown`,
        { method: "POST" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any)?.message ?? (body as any)?.error ?? `status ${res.status}`);
      }
      removeCell(`${d.platform}:${d.id}`);
      setTimeout(async () => {
        await refreshDevices();
        markStopping(d.id, false);
      }, 1000);
    } catch (e: any) {
      markStopping(d.id, false);
      setError(e?.message ?? String(e));
    }
  }, [refreshDevices, removeCell]);

  const runOnNative = useCallback(async (d: StudioDevice) => {
    setRunningNative(d.id);
    try {
      const res = await fetch(
        `/api/devices/${d.platform}/${encodeURIComponent(d.id)}/run-native`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wsUrl: remoteUrl || undefined }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as any)?.message ?? (body as any)?.error ?? `status ${res.status}`);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunningNative(null);
    }
  }, [remoteUrl]);

  const hasCanvasToggle = useMemo(
    () => cells.some((c) => c.kind === "web-canvas"),
    [cells]
  );
  const hasDomToggle = useMemo(
    () => cells.some((c) => c.kind === "web-dom"),
    [cells]
  );

  // Per-cell flex weights, keyed by cellKey. New cells default to 1.
  // Stored as a stable record so a cell that's added/removed/re-added
  // remembers its previous size within a session.
  const [cellWeights, setCellWeights] = useState<Record<string, number>>(loadStoredWeights);
  useEffect(() => { persistWeights(cellWeights); }, [cellWeights]);

  const gridContainerRef = useRef<HTMLDivElement | null>(null);

  const handleDividerResize = useCallback((leftKey: string, rightKey: string, deltaPx: number) => {
    const container = gridContainerRef.current;
    if (!container) return;
    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;

    setCellWeights((prev) => {
      const left = prev[leftKey] ?? 1;
      const right = prev[rightKey] ?? 1;
      const totalForPair = left + right;
      // Convert px delta into a weight delta proportional to this pair's
      // share of the row, so dragging feels 1:1 with on-screen pixels
      // regardless of how many other cells exist.
      const pairShare = totalForPair / Object.values(prev).reduce((a, b) => a + b, 0) || 1;
      const pairPxWidth = containerWidth * pairShare;
      const weightDelta = (deltaPx / pairPxWidth) * totalForPair;

      let nextLeft = left + weightDelta;
      let nextRight = right - weightDelta;
      const minWeight = totalForPair * MIN_CELL_WEIGHT;
      if (nextLeft < minWeight) {
        nextRight -= minWeight - nextLeft;
        nextLeft = minWeight;
      }
      if (nextRight < minWeight) {
        nextLeft -= minWeight - nextRight;
        nextRight = minWeight;
      }
      return { ...prev, [leftKey]: nextLeft, [rightKey]: nextRight };
    });
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-background text-foreground flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center px-3 gap-2 shrink-0">
        <span className="text-sm font-mono">
          <span className="text-[#FFA7E1]">test</span>
          <span className="text-muted-foreground"> mode</span>
        </span>
        <span className="text-xs text-muted-foreground ml-2">
          {activeFile ?? <span className="italic">no file open</span>}
        </span>
        <div className="flex-1" />
        <div className="relative w-72 max-w-[50%] flex items-center gap-1">
          <div className="relative flex-1">
            <input
              type="text"
              spellCheck={false}
              placeholder="Remote dev server — e.g. localhost:3000"
              value={remoteUrlDraft}
              onChange={(e) => setRemoteUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRemoteUrl();
              }}
              className="w-full h-7 px-2.5 rounded-md bg-muted/40 border border-border text-xs font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-[#FFA7E1]/50 focus:border-[#FFA7E1]/50"
              title="Web cells connect here via RemoteEngine. Native runners use it as the deep-link ws URL (Android emulators auto-rewrite localhost → 10.0.2.2). Press Enter to connect."
            />
            {remoteUrlDraft && (
              <button
                onClick={() => setRemoteUrlDraft("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100 p-0.5"
                title="Clear"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {remoteUrl ? (
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={disconnectRemote}>
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              onClick={submitRemoteUrl}
              disabled={!remoteUrlDraft.trim()}
            >
              Connect
            </Button>
          )}
        </div>
        <div className="flex-1" />
        <Button
          variant={hasDomToggle ? "secondary" : "ghost"}
          size="sm"
          className="gap-1.5"
          disabled={!activeFile?.endsWith(".hypen")}
          onClick={() => toggleCell({ kind: "web-dom" })}
        >
          <Monitor className="w-4 h-4" />
          <span className="hidden sm:inline">DOM</span>
        </Button>
        <Button
          variant={hasCanvasToggle ? "secondary" : "ghost"}
          size="sm"
          className="gap-1.5"
          disabled={!activeFile?.endsWith(".hypen")}
          onClick={() => toggleCell({ kind: "web-canvas" })}
        >
          <Palette className="w-4 h-4" />
          <span className="hidden sm:inline">Canvas</span>
        </Button>
        <Button
          variant={logsOpen ? "secondary" : "ghost"}
          size="sm"
          className="gap-1.5"
          onClick={() => setLogsOpen((v) => !v)}
          title="Toggle device logs panel"
        >
          <ScrollText className="w-4 h-4" />
          <span className="hidden sm:inline">Logs</span>
        </Button>
        <RunNativeMenu overrideUrl={remoteUrl} />
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={async () => {
            try {
              const res = await fetch("/api/engine/reset", { method: "POST" });
              if (!res.ok) throw new Error(`status ${res.status}`);
            } catch (e: any) {
              setError(`Engine reset failed: ${e?.message ?? String(e)}`);
            }
          }}
          title="Reset the studio engine — clears module state and re-renders all connected clients"
        >
          <RotateCcw className="w-4 h-4" />
          <span className="hidden sm:inline">Reset</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={refreshDevices} disabled={loading}>
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </Button>
        {typeof window !== "undefined" && window.location.pathname !== "/test-mode" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const qs = activeFile ? `?file=${encodeURIComponent(activeFile)}` : "";
              window.open(`/test-mode${qs}`, "_blank", "noopener,noreferrer");
            }}
            title="Open Test Mode in a new window"
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 border-b border-border bg-red-950/40 text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{error}</span>
          <button className="ml-auto opacity-70 hover:opacity-100" onClick={() => setError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {sidebarCollapsed ? (
          <CollapsedSidebarRail
            deviceCount={devices.android.length + devices.ios.length}
            onExpand={toggleSidebar}
          />
        ) : (
          <DeviceSidebar
            devices={devices}
            cells={cells}
            bootingIds={bootingIds}
            stoppingIds={stoppingIds}
            runningNative={runningNative}
            onToggle={toggleCell}
            onBoot={bootDevice}
            onStop={stopDevice}
            onRunNative={runOnNative}
            onCollapse={toggleSidebar}
          />
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-auto bg-gradient-to-b from-zinc-800 to-zinc-900 p-4">
            {cells.length === 0 ? (
              <EmptyState />
            ) : (
              <div ref={gridContainerRef} className="flex h-full gap-0 items-stretch">
                {cells.map((cell, i) => {
                  const key = cellKey(cell);
                  const weight = cellWeights[key] ?? 1;
                  const isLast = i === cells.length - 1;
                  const nextKey = !isLast ? cellKey(cells[i + 1]!) : null;
                  return (
                    <Fragment key={key}>
                      <div
                        className="min-w-0 h-full"
                        style={{ flex: `${weight} ${weight} 0`, marginRight: isLast ? 0 : 8, marginLeft: i === 0 ? 0 : 8 }}
                      >
                        <CellView
                          cell={cell}
                          activeFile={activeFile}
                          remoteUrl={remoteUrl}
                          onRemove={() => removeCell(key)}
                        />
                      </div>
                      {!isLast && nextKey && (
                        <ResizeHandle
                          direction="vertical"
                          onResize={(d) => handleDividerResize(key, nextKey, d)}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>

          {logsOpen && (
            <DeviceLogs
              devices={[...devices.android, ...devices.ios]
                .filter((d) => d.status === "running")
                .map((d) => ({ id: d.id, platform: d.platform, name: d.name }))}
              onClose={() => setLogsOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────

function CollapsedSidebarRail({ deviceCount, onExpand }: { deviceCount: number; onExpand: () => void }) {
  return (
    <div className="w-8 border-r border-border bg-card/40 shrink-0 flex flex-col items-center pt-2 gap-2">
      <button
        className="p-1 rounded hover:bg-muted/60 opacity-80 hover:opacity-100"
        onClick={onExpand}
        title="Show device sidebar"
      >
        <PanelLeftOpen className="w-4 h-4" />
      </button>
      {deviceCount > 0 && (
        <span
          className="text-[10px] font-mono text-muted-foreground"
          title={`${deviceCount} device${deviceCount === 1 ? "" : "s"}`}
        >
          {deviceCount}
        </span>
      )}
    </div>
  );
}

function DeviceSidebar({
  devices,
  cells,
  bootingIds,
  stoppingIds,
  runningNative,
  onToggle,
  onBoot,
  onStop,
  onRunNative,
  onCollapse,
}: {
  devices: DevicesResponse;
  cells: Cell[];
  bootingIds: Set<string>;
  stoppingIds: Set<string>;
  runningNative: string | null;
  onToggle: (c: Cell) => void;
  onBoot: (d: StudioDevice) => void;
  onStop: (d: StudioDevice) => void;
  onRunNative: (d: StudioDevice) => void;
  onCollapse: () => void;
}) {
  const shown = new Set(cells.map((c) => cellKey(c)));

  return (
    <div className="w-64 border-r border-border bg-card/40 overflow-y-auto shrink-0 flex flex-col">
      <div className="flex items-center justify-between px-2 h-7 border-b border-border/60 shrink-0">
        <span className="text-[10px] font-mono uppercase text-muted-foreground tracking-wider">Devices</span>
        <button
          className="p-0.5 rounded hover:bg-muted/60 opacity-70 hover:opacity-100"
          onClick={onCollapse}
          title="Collapse sidebar"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <SidebarSection
        title={`iOS (${devices.ios.length})`}
        icon={<Apple className="w-3.5 h-3.5" />}
        status={
          !devices.iosStreamer ? "off"
          : !devices.iosReachable ? "error"
          : "on"
        }
      >
        {!devices.iosStreamer && (
          <SidebarEmpty>
            iOS streamer not configured. Launch `hypen studio` on macOS with
            Xcode installed.
          </SidebarEmpty>
        )}
        {devices.iosStreamer && !devices.iosReachable && (
          <SidebarEmpty>
            <div className="text-red-300">Streamer unreachable.</div>
            {devices.iosDiagnostic && (
              <div className="mt-1 text-[10px] break-words">{devices.iosDiagnostic}</div>
            )}
          </SidebarEmpty>
        )}
        {devices.iosStreamer && devices.iosReachable && devices.ios.length === 0 && (
          <SidebarEmpty>
            {devices.iosDiagnostic ?? "No simulators detected."}
          </SidebarEmpty>
        )}
        {devices.ios.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            displayed={shown.has(`${d.platform}:${d.id}`)}
            booting={bootingIds.has(d.id)}
            stopping={stoppingIds.has(d.id)}
            runningNative={runningNative === d.id}
            onToggle={() => onToggle({ kind: "device", device: d })}
            onBoot={() => onBoot(d)}
            onStop={() => onStop(d)}
            onRunNative={() => onRunNative(d)}
          />
        ))}
      </SidebarSection>

      <SidebarSection title={`Android (${devices.android.length})`} icon={<Bot className="w-3.5 h-3.5" />}>
        {devices.android.length === 0 && (
          <SidebarEmpty>
            No AVDs or connected devices. Install Android SDK + create an AVD,
            or attach a device via adb.
          </SidebarEmpty>
        )}
        {devices.android.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            displayed={shown.has(`${d.platform}:${d.id}`)}
            booting={bootingIds.has(d.id)}
            stopping={stoppingIds.has(d.id)}
            runningNative={runningNative === d.id}
            onToggle={() => onToggle({ kind: "device", device: d })}
            onBoot={() => onBoot(d)}
            onStop={() => onStop(d)}
            onRunNative={() => onRunNative(d)}
          />
        ))}
      </SidebarSection>
    </div>
  );
}

function SidebarSection({
  title,
  icon,
  children,
  status,
  defaultCollapsed,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  status?: "on" | "off" | "error";
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const dot = status === "on" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : status === "off" ? "bg-zinc-500" : null;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {icon}
        <span className="truncate">{title}</span>
        {dot && <span className={cn("ml-auto w-1.5 h-1.5 rounded-full", dot)} />}
      </button>
      {!collapsed && <div className="px-1 pb-2">{children}</div>}
    </div>
  );
}

function SidebarEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-2 text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </div>
  );
}

function DeviceRow({
  device,
  displayed,
  booting,
  stopping,
  runningNative,
  onToggle,
  onBoot,
  onStop,
  onRunNative,
}: {
  device: StudioDevice;
  displayed: boolean;
  booting: boolean;
  stopping: boolean;
  runningNative: boolean;
  onToggle: () => void;
  onBoot?: () => void;
  onStop?: () => void;
  onRunNative?: () => void;
}) {
  const running = device.status === "running";
  const inFlight = booting || stopping;
  // State machine for the primary action button:
  //   booting → yellow Loader (no-op)
  //   running → red Square (stop)
  //   stopped → green Play (boot)
  let actionButton: React.ReactNode = null;
  if (inFlight) {
    actionButton = (
      <button
        className="p-1 opacity-90 cursor-wait"
        disabled
        title={booting ? "Booting…" : "Shutting down…"}
      >
        <Loader2 className="w-3 h-3 animate-spin text-yellow-400" />
      </button>
    );
  } else if (running && onStop) {
    actionButton = (
      <button
        className="opacity-70 hover:opacity-100 p-1"
        onClick={(e) => { e.stopPropagation(); onStop(); }}
        title="Stop / shutdown"
      >
        <Square className="w-3 h-3 fill-red-400 text-red-400" />
      </button>
    );
  } else if (onBoot) {
    actionButton = (
      <button
        className="opacity-70 hover:opacity-100 p-1"
        onClick={(e) => { e.stopPropagation(); onBoot(); }}
        title="Boot device"
      >
        <Play className="w-3 h-3 fill-emerald-400 text-emerald-400" />
      </button>
    );
  }

  const statusLabel = booting
    ? " • booting…"
    : stopping
      ? " • stopping…"
      : running
        ? " • running"
        : " • stopped";

  return (
    <div
      className={cn(
        "rounded-md px-2 py-1.5 text-xs flex items-center gap-2 cursor-pointer",
        displayed ? "bg-secondary" : "hover:bg-muted/40"
      )}
      onClick={running && !inFlight ? onToggle : undefined}
      title={running ? "Click to toggle on grid" : "Boot the device to preview"}
    >
      <Smartphone className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="truncate">{device.name}</div>
        <div className="text-[10px] text-muted-foreground truncate">
          {device.subtitle ?? device.id}
          {statusLabel}
        </div>
      </div>
      {running && !inFlight && onRunNative && (
        <button
          className="opacity-70 hover:opacity-100 p-1"
          onClick={(e) => { e.stopPropagation(); onRunNative(); }}
          disabled={runningNative}
          title="Install Hypen Runner and launch the app on this device"
        >
          {runningNative
            ? <Loader2 className="w-3 h-3 animate-spin text-[#FFA7E1]" />
            : <Rocket className="w-3 h-3 text-[#FFA7E1]" />}
        </button>
      )}
      {actionButton}
    </div>
  );
}

// ─── Grid cells ───────────────────────────────────────────

function popOutUrlFor(cell: Cell, activeFile: string | null, remoteUrl: string): string | null {
  if (cell.kind === "web-dom" || cell.kind === "web-canvas") {
    const qs = new URLSearchParams({
      renderer: cell.kind === "web-dom" ? "dom" : "canvas",
      name: cellTitle(cell),
    });
    if (remoteUrl) qs.set("remoteUrl", remoteUrl);
    else if (activeFile?.endsWith(".hypen")) qs.set("file", activeFile);
    else return null;
    return `/cell-viewer?${qs.toString()}`;
  }
  if (cell.kind === "device") {
    if (!cell.device.streamUrl) return null;
    const qs = new URLSearchParams({
      streamUrl: cell.device.streamUrl,
      name: cellTitle(cell),
    });
    return `/cell-viewer?${qs.toString()}`;
  }
  return null;
}

function CellView({
  cell,
  activeFile,
  remoteUrl,
  onRemove,
}: {
  cell: Cell;
  activeFile: string | null;
  remoteUrl: string;
  onRemove: () => void;
}) {
  const popOutUrl = popOutUrlFor(cell, activeFile, remoteUrl);
  const popOut = () => {
    if (!popOutUrl) return;
    window.open(popOutUrl, `hypen-cell-${cellKey(cell)}`, "popup,width=420,height=820");
  };
  return (
    <div className="rounded-xl overflow-hidden border border-border bg-black flex flex-col h-full">
      <div className="h-8 px-3 flex items-center gap-2 border-b border-border bg-card/50 shrink-0">
        <span className="text-[11px] text-muted-foreground truncate">{cellTitle(cell)}</span>
        <div className="flex-1" />
        {popOutUrl && (
          <button
            className="opacity-60 hover:opacity-100"
            onClick={popOut}
            title="Pop out to detached window"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button className="opacity-60 hover:opacity-100" onClick={onRemove} title="Remove cell">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 relative min-h-0 bg-black">
        <CellBody cell={cell} activeFile={activeFile} remoteUrl={remoteUrl} />
      </div>
    </div>
  );
}

function CellBody({ cell, activeFile, remoteUrl }: { cell: Cell; activeFile: string | null; remoteUrl: string }) {
  if (cell.kind === "web-dom" || cell.kind === "web-canvas") {
    const qs = new URLSearchParams({
      renderer: cell.kind === "web-dom" ? "dom" : "canvas",
    });
    // Default: stream from the studio-hosted engine at /ws/engine — same
    // engine feeds native runners, so all surfaces stay in sync. The user
    // can override per-session by typing a URL in the toolbar (e.g. to
    // preview against an external `hypen dev`).
    if (remoteUrl) {
      qs.set("remoteUrl", remoteUrl);
    } else {
      const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = typeof window !== "undefined" ? window.location.host : "localhost:5173";
      qs.set("remoteUrl", `${proto}//${host}/ws/engine`);
    }
    // Activefile as a hint for the engine host (which component to focus).
    if (activeFile?.endsWith(".hypen")) {
      qs.set("file", activeFile);
    }
    return (
      <iframe
        src={`/preview-frame?${qs.toString()}`}
        className="absolute inset-0 w-full h-full border-0 bg-white"
        title={cellTitle(cell)}
      />
    );
  }

  if (cell.kind === "device") {
    return <DeviceMirror device={cell.device} />;
  }

  return null;
}

/**
 * Renders a live mirror for a running device.
 * Preference order: WebRTC (Android, when -grpc) → fragmented MP4 (iOS) → MJPEG.
 * MJPEG and <video> cells forward clicks as device taps; the WebRTC cell
 * does its own input handling inside android-emulator-webrtc.
 */
function DeviceMirror({ device }: { device: StudioDevice }) {
  const [webrtcFailed, setWebrtcFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  if (!device.streamUrl && !device.videoUrl && !device.webrtcUrl) {
    return <CellMessage>Device not running</CellMessage>;
  }

  if (device.webrtcUrl && !webrtcFailed) {
    return (
      <AndroidWebRTCCell
        uri={device.webrtcUrl}
        name={device.name}
        onError={() => setWebrtcFailed(true)}
      />
    );
  }

  if (device.videoUrl && !videoFailed) {
    return (
      <TapForwardingMedia
        device={device}
        src={device.videoUrl}
        kind="video"
        onError={() => setVideoFailed(true)}
      />
    );
  }

  if (!device.streamUrl) {
    return <CellMessage>No stream available</CellMessage>;
  }

  return <TapForwardingMedia device={device} src={device.streamUrl} kind="image" />;
}

/**
 * Wraps an <img> or <video> stream with pointer-to-device input forwarding.
 *
 * Short press → tap. Press-and-drag past the swipe threshold → swipe.
 * object-fit: contain is undone when mapping pointer coordinates back to
 * the device's pixel space, so taps/swipes hit the right spot regardless
 * of the cell's aspect ratio.
 */
const SWIPE_THRESHOLD_PX = 8;

function TapForwardingMedia({
  device,
  src,
  kind,
  onError,
}: {
  device: StudioDevice;
  src: string;
  kind: "image" | "video";
  onError?: () => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const toDeviceCoords = (e: React.PointerEvent<HTMLElement>): { x: number; y: number } | null => {
    if (!size) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / size.w, rect.height / size.h);
    const drawnW = size.w * scale;
    const drawnH = size.h * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;
    const localX = e.clientX - rect.left - offsetX;
    const localY = e.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > drawnW || localY > drawnH) return null;
    return { x: Math.round(localX / scale), y: Math.round(localY / scale) };
  };

  const send = async (action: Record<string, unknown>) => {
    try {
      await fetch(
        `/api/devices/${device.platform}/${encodeURIComponent(device.id)}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        }
      );
    } catch (err) {
      console.warn(`[${device.name}] input failed (${action.type})`, err);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const coords = toDeviceCoords(e);
    if (!coords) return;
    dragStartRef.current = { x: coords.x, y: coords.y, t: Date.now() };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!start) return;

    const end = toDeviceCoords(e);
    if (!end) return;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);

    if (distance < SWIPE_THRESHOLD_PX) {
      send({ type: "tap", x: end.x, y: end.y });
    } else {
      send({
        type: "swipe",
        x1: start.x, y1: start.y,
        x2: end.x, y2: end.y,
        durationMs: Math.max(100, Math.min(1000, Date.now() - start.t)),
      });
    }
  };

  const common = {
    onPointerDown: handlePointerDown,
    onPointerUp: handlePointerUp,
    onPointerCancel: () => { dragStartRef.current = null; },
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    className: "absolute inset-0 w-full h-full object-contain bg-black cursor-pointer select-none touch-none",
  };

  if (kind === "video") {
    return (
      <video
        {...common}
        src={src}
        autoPlay
        muted
        playsInline
        onError={onError}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setSize({ w: v.videoWidth, h: v.videoHeight });
        }}
      />
    );
  }

  return (
    <img
      {...common}
      src={src}
      alt={device.name}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) {
          setSize({ w: img.naturalWidth, h: img.naturalHeight });
        }
      }}
    />
  );
}

function CellMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      <div className="text-center">
        <p className="mb-2">Pick preview surfaces from the toolbar above</p>
        <p className="text-xs">or boot a device from the sidebar to see it here.</p>
      </div>
    </div>
  );
}
