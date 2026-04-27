import { join } from "path";
import { tmpdir } from "os";
import { existsSync, unlinkSync } from "fs";

import type { Shell } from "./types.ts";
import { bunShell, commandExists } from "./shell.ts";

/**
 * Live H.264 → fragmented MP4 stream for a booted simulator.
 *
 * Pipeline:
 *   xcrun simctl io <udid> recordVideo --codec=h264 <fifo>
 *     │
 *     ▼  (named pipe)
 *   ffmpeg -i <fifo> -c:v copy -f mp4 \
 *          -movflags frag_keyframe+empty_moov+default_base_moof pipe:1
 *
 * The HTTP handler streams ffmpeg's stdout straight to the browser, where a
 * `<video>` tag (Chromium) or MediaSource consumer (cross-browser) plays the
 * fragmented MP4 in real time.
 *
 * Requires `ffmpeg` on PATH. `xcrun simctl recordVideo` requires Xcode 11+.
 *
 * NOTE: end-to-end verification needs a macOS host with a booted simulator;
 * this implementation is structured so the only Mac-specific piece is the
 * `xcrun` invocation.
 */

export interface VideoStreamOptions {
  shell?: Shell;
  signal?: AbortSignal;
  /** Keyframe interval hint (frames). Lower = lower latency, higher CPU. Default 24. */
  keyframeInterval?: number;
}

export async function hasFfmpeg(shell: Shell = bunShell): Promise<boolean> {
  return commandExists("ffmpeg", shell);
}

function uniqueFifoPath(udid: string): string {
  return join(tmpdir(), `hypen-sim-${udid}-${process.pid}-${Date.now()}.h264`);
}

/**
 * Build the ffmpeg argv used to remux raw H.264 from a fifo into a
 * fragmented MP4 stream on stdout. Exposed so the studio can reuse the
 * exact same flags and tests can assert them.
 */
export function ffmpegFragmentedMp4Cmd(fifoPath: string): string[] {
  return [
    "ffmpeg",
    "-loglevel", "error",
    "-fflags", "+nobuffer+genpts",
    "-i", fifoPath,
    "-c:v", "copy",
    "-an",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
    "-reset_timestamps", "1",
    "pipe:1",
  ];
}

export function simctlRecordCmd(udid: string, fifoPath: string): string[] {
  return ["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", fifoPath];
}

/**
 * Start a fragmented-MP4 stream. Returns a ReadableStream that ends when the
 * client cancels (via `signal`) or when either subprocess exits. All resources
 * (fifo, child processes) are cleaned up on close.
 */
export async function createMp4Stream(
  udid: string,
  opts: VideoStreamOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const fifo = uniqueFifoPath(udid);

  // mkfifo via shell — cross-Bun-version safe.
  const mk = await (opts.shell ?? bunShell)(["mkfifo", fifo]);
  if (mk.exitCode !== 0) {
    throw new Error(`mkfifo failed: ${mk.stderr.trim()}`);
  }

  // Start the iOS recorder. simctl writes H.264 chunks to the fifo as they
  // become available; it terminates cleanly on SIGINT, flushing the trailer.
  const recorder = Bun.spawn(simctlRecordCmd(udid, fifo), {
    stdout: "ignore",
    stderr: "pipe",
  });

  // Start ffmpeg, reading from the fifo and emitting fragmented MP4 on stdout.
  const ff = Bun.spawn(ffmpegFragmentedMp4Cmd(fifo), {
    stdout: "pipe",
    stderr: "pipe",
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { recorder.kill("SIGINT"); } catch { /* already dead */ }
    try { ff.kill(); } catch { /* already dead */ }
    if (existsSync(fifo)) {
      try { unlinkSync(fifo); } catch { /* already gone */ }
    }
  };

  // If either process exits unexpectedly, tear down the stream.
  recorder.exited.then(cleanup);
  ff.exited.then(cleanup);
  opts.signal?.addEventListener("abort", cleanup, { once: true });

  // Hand back ffmpeg's stdout, wrapping the cancel hook so close cleans up.
  const upstream = ff.stdout as ReadableStream<Uint8Array>;
  const reader = upstream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanup();
        controller.error(err);
      }
    },
    cancel() {
      try { reader.cancel(); } catch { /* ignore */ }
      cleanup();
    },
  });
}
