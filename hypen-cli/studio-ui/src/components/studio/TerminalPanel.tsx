import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
      lineHeight: 1.3,
      theme: {
        background: "#1c1c1c",
        foreground: "#e0e0e0",
        cursor: "#FFA7E1",
        selectionBackground: "#FFA7E140",
        black: "#1c1c1c",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#FFA7E1",
        cyan: "#22d3ee",
        white: "#e0e0e0",
        brightBlack: "#6b7280",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#FFD4F0",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Delay WebSocket connection to survive rapid mount/unmount re-render cycles.
    // Without this, React re-renders cause: mount → spawn PTY → unmount → kill PTY → remount → spawn again,
    // and the user briefly sees "[Disconnected]" from the first killed connection.
    let ws: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const connectTimer = setTimeout(() => {
      fitAddon.fit();

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);
      wsRef.current = ws;

      ws.onopen = () => {
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          ws!.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            terminal.write(msg.data);
          } else if (msg.type === "exit") {
            terminal.writeln(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m`);
          } else if (msg.type === "error") {
            terminal.writeln(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m`);
          }
        } catch (e) {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        terminal.writeln("\r\n\x1b[90m[Disconnected]\x1b[0m");
      };

      // Forward terminal input to WebSocket
      terminal.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Handle container resize
      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (!fitAddonRef.current || !wsRef.current) return;
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows })
            );
          }
        });
      });
      resizeObserver.observe(container);
    }, 100);

    return () => {
      clearTimeout(connectTimer);
      resizeObserver?.disconnect();
      terminal.dispose();
      if (ws) ws.close();
      wsRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ padding: "4px 0 0 8px" }}
    />
  );
}
