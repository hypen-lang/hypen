import type { StreamerOptions, InputAction } from "./types.ts";
import { bunShell, bunBinaryShell } from "./shell.ts";
import { boot, listDevices, screenshot, shutdown } from "./simctl.ts";
import { createMjpegStream, mjpegContentType } from "./stream.ts";
import { dispatch as dispatchInput, hasIdb } from "./idb.ts";
import { createMp4Stream, hasFfmpeg } from "./video.ts";

/**
 * HTTP API:
 *   GET  /health                             -> { ok: true, idb: boolean }
 *   GET  /devices                            -> Simulator[]
 *   POST /devices/:udid/boot                 -> { ok: true }
 *   POST /devices/:udid/shutdown             -> { ok: true }
 *   GET  /devices/:udid/screenshot.jpg       -> JPEG bytes
 *   GET  /stream/:udid?fps=12                -> multipart MJPEG
 *   POST /devices/:udid/input  body=InputAction -> { ok: true }
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

function serverError(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: "server_error", message }, { status: 500 });
}

export interface StartedServer {
  port: number;
  hostname: string;
  url: string;
  stop: () => void;
}

export async function startServer(opts: StreamerOptions = {}): Promise<StartedServer> {
  const port = opts.port ?? 7711;
  const hostname = opts.host ?? "127.0.0.1";
  const fps = opts.fps ?? 12;
  const shell = opts.shell ?? bunShell;
  const binaryShell = opts.binaryShell ?? bunBinaryShell;

  const idbAvailable = await hasIdb(shell);
  const ffmpegAvailable = await hasFfmpeg(shell);

  const debug = Bun.env.HYPEN_IOS_STREAMER_DEBUG === "1" || Bun.env.HYPEN_IOS_STREAMER_DEBUG === "true";
  const log = (...args: unknown[]) => { if (debug) console.log("[ios-streamer]", ...args); };

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;
      log(`${method} ${pathname}`);

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      try {
        if (pathname === "/health" && method === "GET") {
          return json({ ok: true, idb: idbAvailable, ffmpeg: ffmpegAvailable, fps });
        }

        if (pathname === "/devices" && method === "GET") {
          const devices = await listDevices(shell);
          log(`  devices listed: ${devices.length}`);
          return json({ devices });
        }

        const deviceMatch = pathname.match(/^\/devices\/([^/]+)\/(boot|shutdown|input|screenshot\.jpg)$/);
        if (deviceMatch) {
          const udid = decodeURIComponent(deviceMatch[1]!);
          const action = deviceMatch[2]!;

          if (action === "boot" && method === "POST") {
            await boot(udid, shell);
            return json({ ok: true });
          }
          if (action === "shutdown" && method === "POST") {
            await shutdown(udid, shell);
            return json({ ok: true });
          }
          if (action === "screenshot.jpg" && method === "GET") {
            const bytes = await screenshot(udid, "jpeg", binaryShell, shell);
            return new Response(bytes as BlobPart, {
              headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "no-store",
                ...CORS_HEADERS,
              },
            });
          }
          if (action === "input" && method === "POST") {
            if (!idbAvailable) {
              return json(
                { error: "idb_not_installed", message: "Install fb-idb to enable input forwarding." },
                { status: 501 }
              );
            }
            const body = (await req.json()) as InputAction;
            if (!body || typeof body !== "object" || !("type" in body)) {
              return badRequest("Body must be an InputAction");
            }
            await dispatchInput(udid, body, shell);
            return json({ ok: true });
          }
        }

        const streamMatch = pathname.match(/^\/stream\/([^/]+)$/);
        if (streamMatch && method === "GET") {
          const udid = decodeURIComponent(streamMatch[1]!);
          const fpsParam = Number(url.searchParams.get("fps") ?? fps);
          const stream = createMjpegStream(udid, {
            fps: Number.isFinite(fpsParam) ? fpsParam : fps,
            binaryShell,
            shell,
            signal: req.signal,
          });
          return new Response(stream, {
            headers: {
              "Content-Type": mjpegContentType(),
              "Cache-Control": "no-store",
              "Connection": "close",
              ...CORS_HEADERS,
            },
          });
        }

        // Fragmented MP4 (H.264) — preferred over MJPEG when ffmpeg is available.
        const videoMatch = pathname.match(/^\/video\/([^/]+)$/);
        if (videoMatch && method === "GET") {
          if (!ffmpegAvailable) {
            return json(
              { error: "ffmpeg_not_installed", message: "Install ffmpeg to use the H.264 video stream." },
              { status: 501 }
            );
          }
          const udid = decodeURIComponent(videoMatch[1]!);
          const mp4 = await createMp4Stream(udid, { shell, signal: req.signal });
          return new Response(mp4, {
            headers: {
              "Content-Type": "video/mp4",
              "Cache-Control": "no-store",
              "Connection": "close",
              ...CORS_HEADERS,
            },
          });
        }

        return notFound();
      } catch (err) {
        return serverError(err);
      }
    },
  });

  const boundPort = server.port ?? port;
  const boundHost = server.hostname ?? hostname;
  return {
    port: boundPort,
    hostname: boundHost,
    url: `http://${boundHost}:${boundPort}`,
    stop: () => server.stop(true),
  };
}
