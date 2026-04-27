#!/usr/bin/env bun
/**
 * @hypen-space/ios-streamer CLI
 *
 *   hypen-ios-streamer [--port 7711] [--host 127.0.0.1] [--fps 12]
 */

import { startServer } from "../src/server.ts";

function parseArgs(argv: string[]): { port?: number; host?: string; fps?: number; help?: boolean } {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    if (arg === "--port" || arg === "-p") out.port = Number(next());
    else if (arg === "--host") out.host = next();
    else if (arg === "--fps") out.fps = Number(next());
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const HELP = `
hypen-ios-streamer — control & stream iOS Simulators over HTTP

Usage:
  hypen-ios-streamer [--port 7711] [--host 127.0.0.1] [--fps 12]

Endpoints:
  GET  /health
  GET  /devices
  POST /devices/:udid/boot
  POST /devices/:udid/shutdown
  GET  /devices/:udid/screenshot.jpg
  GET  /stream/:udid?fps=12       (multipart MJPEG)
  POST /devices/:udid/input       (body: { type: "tap", x, y } | swipe | text | key)

Requires xcrun (Xcode command line tools). Input forwarding additionally
requires fb-idb (https://fbidb.io). Without idb the streamer is read-only.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const server = await startServer({ port: args.port, host: args.host, fps: args.fps });
console.log(`hypen-ios-streamer listening on ${server.url}`);

const shutdown = () => {
  console.log("\nShutting down…");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
