import type { BinaryShell, Shell } from "./types.ts";
import { bunBinaryShell, bunShell } from "./shell.ts";
import { screenshot } from "./simctl.ts";

/**
 * Build an MJPEG (multipart/x-mixed-replace) ReadableStream that polls
 * `simctl screenshot` at the requested frame rate and pushes each JPEG
 * back as a fresh part. Works in any `<img src="...">` tag.
 *
 * The stream stops automatically when the consumer cancels (closes the
 * connection) or when a screenshot call fails repeatedly — typically because
 * the simulator was shut down.
 */
export interface MjpegStreamOptions {
  fps: number;
  binaryShell?: BinaryShell;
  shell?: Shell;
  /** Stop after N consecutive screenshot errors. Default 3. */
  maxConsecutiveErrors?: number;
  /** Optional signal to abort externally. */
  signal?: AbortSignal;
}

export const MJPEG_BOUNDARY = "hypenframe";

export function createMjpegStream(udid: string, opts: MjpegStreamOptions): ReadableStream<Uint8Array> {
  const fps = Math.max(1, Math.min(30, opts.fps));
  const intervalMs = Math.floor(1000 / fps);
  const binaryShell = opts.binaryShell ?? bunBinaryShell;
  const shell = opts.shell ?? bunShell;
  const maxErrors = opts.maxConsecutiveErrors ?? 3;

  let cancelled = false;
  let consecutiveErrors = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => {
        cancelled = true;
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const encoder = new TextEncoder();

      while (!cancelled) {
        const frameStart = Date.now();
        try {
          const jpeg = await screenshot(udid, "jpeg", binaryShell, shell);
          consecutiveErrors = 0;

          const header = encoder.encode(
            `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.byteLength}\r\n\r\n`
          );
          controller.enqueue(header);
          controller.enqueue(jpeg);
          controller.enqueue(encoder.encode("\r\n"));
        } catch (err) {
          consecutiveErrors++;
          // Surface the real reason frames stopped arriving — otherwise the
          // UI shows a black cell with no hint as to why.
          console.warn(`[ios-streamer] frame capture failed (${consecutiveErrors}/${maxErrors}) for ${udid}:`, err instanceof Error ? err.message : err);
          if (consecutiveErrors >= maxErrors) break;
        }

        const elapsed = Date.now() - frameStart;
        const wait = Math.max(0, intervalMs - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      opts.signal?.removeEventListener("abort", onAbort);
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

export function mjpegContentType(): string {
  return `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`;
}
