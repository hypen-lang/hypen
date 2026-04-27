/**
 * Live device-log drawer for Test Mode. One tab per running device; clicking
 * a tab opens a WebSocket to `/ws/device-logs?platform=&id=` which tails
 * `adb logcat` (Android) or `xcrun simctl spawn <udid> log stream` (iOS).
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { X, Trash2, ScrollText } from "lucide-react";

type DeviceRef = {
  id: string;
  platform: "android" | "ios";
  name: string;
};

const MAX_LINES = 1000;

function useDeviceLogs(device: DeviceRef | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setLines([]);
    setConnected(false);
    if (!device) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({ platform: device.platform, id: device.id });
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/device-logs?${qs.toString()}`);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (ev) => {
      setLines((prev) => {
        const next = [...prev, String(ev.data)];
        if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
        return next;
      });
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    return () => {
      // Avoid "WebSocket closed before connection was established" noise in
      // React StrictMode dev mounts.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", () => { try { ws.close(); } catch {} }, { once: true });
      } else {
        try { ws.close(); } catch { /* already closed */ }
      }
    };
  }, [device?.id, device?.platform]);

  const clear = () => setLines([]);
  return { lines, connected, clear };
}

export function DeviceLogs({
  devices,
  onClose,
}: {
  devices: DeviceRef[];
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(devices[0]?.id ?? null);
  const active = devices.find((d) => d.id === activeId) ?? devices[0] ?? null;
  const { lines, connected, clear } = useDeviceLogs(active);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="border-t border-border bg-card/40 flex flex-col shrink-0" style={{ height: 220 }}>
      <div className="h-8 px-3 flex items-center gap-1 border-b border-border shrink-0">
        <ScrollText className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground mr-2">Logs</span>

        <div className="flex items-center gap-1 overflow-x-auto">
          {devices.length === 0 && (
            <span className="text-xs text-muted-foreground">No running devices.</span>
          )}
          {devices.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveId(d.id)}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded border whitespace-nowrap",
                active?.id === d.id
                  ? "bg-secondary border-border"
                  : "border-transparent hover:border-border"
              )}
            >
              {d.name}
              <span className="text-muted-foreground ml-1 text-[9px]">
                {d.platform}
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full mr-1",
            connected ? "bg-emerald-400" : "bg-zinc-500"
          )}
          title={connected ? "streaming" : "disconnected"}
        />
        <button className="opacity-60 hover:opacity-100 p-1" onClick={clear} title="Clear">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button className="opacity-60 hover:opacity-100 p-1" onClick={onClose} title="Close logs panel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto font-mono text-[11px] leading-snug px-3 py-2 text-muted-foreground bg-black/40"
      >
        {active ? (
          lines.length === 0 ? (
            <span className="opacity-60">
              {connected ? "Waiting for log output…" : "Connecting…"}
            </span>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )
        ) : (
          <span className="opacity-60">Boot a device to tail its logs.</span>
        )}
      </div>
    </div>
  );
}
