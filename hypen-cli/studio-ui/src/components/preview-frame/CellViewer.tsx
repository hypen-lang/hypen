/**
 * Standalone cell viewer page used when a Test Mode cell is "popped out"
 * into its own window via window.open().
 *
 * URL params:
 *   ?streamUrl=<absolute MJPEG / WebRTC URL>&name=<label>          (device cells)
 *   ?renderer=dom|canvas&file=<path>                               (web cells)
 *   ?renderer=dom|canvas&remoteUrl=<ws://...>                      (web cells, remote)
 *
 * Web cells delegate to /preview-frame inside an iframe; device cells render
 * the stream URL directly as an <img>.
 */
import { useEffect } from "react";

export function CellViewer() {
  const params = new URLSearchParams(window.location.search);
  const streamUrl = params.get("streamUrl");
  const renderer = params.get("renderer") as "dom" | "canvas" | null;
  const file = params.get("file");
  // Test Mode's web cells stream from a RemoteServer; their pop-out URL
  // carries that server instead of a file.
  const remoteUrl = params.get("remoteUrl");
  const name = params.get("name") ?? (renderer ? `Web • ${renderer}` : "Cell");

  useEffect(() => {
    document.title = `${name} — Hypen Studio`;
  }, [name]);

  if (streamUrl) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#000", display: "flex" }}>
        <img
          src={streamUrl}
          alt={name}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </div>
    );
  }

  if (renderer && (file || remoteUrl)) {
    const qs = new URLSearchParams(remoteUrl ? { renderer, remoteUrl } : { renderer, file: file! });
    return (
      <div style={{ position: "fixed", inset: 0, background: "#000" }}>
        <iframe
          src={`/preview-frame?${qs.toString()}`}
          title={name}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "white" }}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: "system-ui", color: "#888" }}>
      Missing parameters. Provide either <code>streamUrl=…</code>, <code>renderer=…&amp;file=…</code> or <code>renderer=…&amp;remoteUrl=…</code>.
    </div>
  );
}

export default CellViewer;
