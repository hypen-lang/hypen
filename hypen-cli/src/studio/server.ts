/**
 * Hypen Studio Server
 *
 * A local development IDE with file browser, code editor, live preview,
 * state inspector, action log, and time-travel debugging.
 */

import { resolve, dirname } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { pink, yellow, dim, boldPink } from "../colors.js";

interface SessionData {
  example: string;
  hypenCode: string;
  moduleCode: string;
  state: Record<string, any>;
  stateHistory: any[];
}

interface StudioOptions {
  components: string;
  entry: string;
  port: number;
  open?: boolean;
  session?: SessionData | null;
  remoteUrl?: string;
  /** Open the browser straight into Test Mode (`/test-mode`). Used by `hypen test`. */
  testMode?: boolean;
}

/** Poll /health until 2xx or `timeoutMs` elapses. */
async function waitForStreamer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Find the first free TCP port at or after `start`. Tries up to `maxAttempts`
 * consecutive ports, briefly binding each one to confirm availability. We
 * also reserve `port + 1` (the iOS-streamer sidecar port) on darwin so the
 * studio server and the streamer don't collide.
 */
async function findAvailablePort(start: number, maxAttempts = 20, reserveNext = false): Promise<number> {
  const tryBind = (p: number): Promise<boolean> =>
    new Promise((res) => {
      try {
        const srv = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
        srv.stop(true);
        res(true);
      } catch {
        res(false);
      }
    });

  for (let i = 0; i < maxAttempts; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    const ok = await tryBind(candidate);
    if (!ok) continue;
    if (reserveNext && candidate + 1 <= 65535) {
      const sidecarOk = await tryBind(candidate + 1);
      if (!sidecarOk) continue;
    }
    return candidate;
  }
  throw new Error(`No free port found in range ${start}..${start + maxAttempts - 1}`);
}

/**
 * Start Hypen Studio server
 */
export async function studio(options: StudioOptions) {
  if (typeof globalThis.Bun === "undefined") {
    console.error("Error: Hypen Studio requires the Bun runtime. Install from https://bun.sh");
    process.exit(1);
  }

  const cwd = process.cwd();

  // Banner — swap "STUDIO" → "TEST" when launched as `hypen test` so the
  // user gets honest feedback about what they ran. Both labels are padded
  // to 24 visible columns so the box's right wall stays aligned.
  const bannerLabel = options.testMode
    ? `${dim("T E S T")}                 ` // 7 visible + 17 spaces = 24
    : `${dim("S T U D I O")}             `; // 11 visible + 13 spaces = 24
  console.log(`
  ${pink("╔═══════════════════════════════════════╗")}
  ${pink("║")}                                       ${pink("║")}
  ${pink("║")}   ${boldPink("H Y P E N")}   ${bannerLabel}${pink("║")}
  ${pink("║")}                                       ${pink("║")}
  ${pink("╚═══════════════════════════════════════╝")}
  `);

  // Path to studio-ui — walk up to the CLI package root (which contains
  // package.json) so this works from both src/ and dist/ layouts.
  let pkgRoot = import.meta.dir;
  while (pkgRoot !== "/" && !existsSync(resolve(pkgRoot, "package.json"))) {
    pkgRoot = dirname(pkgRoot);
  }
  const studioUiPath = resolve(pkgRoot, "studio-ui");
  const studioServerPath = resolve(studioUiPath, "src/index.tsx");

  // Find a free port for the studio-ui server. The studio-ui subprocess
  // does Bun.serve({ port }) with no fallback of its own, so if the
  // requested port is taken the subprocess crashes silently and Studio
  // appears to "hang". On darwin we also need `port + 1` for the iOS
  // streamer sidecar, so reserve both as a pair.
  let studioPort: number;
  try {
    studioPort = await findAvailablePort(options.port, 20, process.platform === "darwin");
  } catch (e: any) {
    console.error(`  ${dim("Could not find a free port for Studio:")} ${e?.message ?? e}`);
    process.exit(1);
  }
  if (studioPort !== options.port) {
    console.log(`  ${dim(`Port ${options.port} in use, using ${studioPort} instead.`)}`);
  }

  console.log(`  ${dim("Project:")}    ${cwd}`);
  console.log(`  ${dim("Components:")} ${options.components}`);
  console.log(`  ${dim("Entry:")}      ${options.entry}`);
  console.log(`  ${dim("Port:")}       ${yellow(String(studioPort))}`);
  if (options.session) {
    console.log(`  ${pink("Session:")}    loaded from teleport`);
  }
  if (options.remoteUrl) {
    console.log(`  ${pink("Remote:")}     ${yellow(options.remoteUrl)}`);
  }
  console.log("");

// If session data exists, write it to a temp file
  let sessionFilePath = "";
  if (options.session) {
    const sessionDir = resolve(tmpdir(), "hypen-studio");
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    sessionFilePath = resolve(sessionDir, `session-${Date.now()}.json`);
    writeFileSync(sessionFilePath, JSON.stringify(options.session, null, 2));
    console.log(`  Session file: ${sessionFilePath}`);
  }

  // Resolve LSP server path: monorepo sibling (dev) → npm package (production)
  const monorepoLsp = resolve(dirname(import.meta.dir), "../../hypen-lsp/src/server.ts");
  let lspServerPath = "";
  if (existsSync(monorepoLsp)) {
    lspServerPath = monorepoLsp;
  } else {
    try {
      // Resolve from CLI's node_modules (npm install)
      // Use import.meta.resolve() for ESM compatibility; fall back to require.resolve() for CJS/Bun
      if (typeof import.meta.resolve === "function") {
        const resolved = import.meta.resolve("@hypen-space/lsp/src/server.ts");
        // import.meta.resolve returns a URL string (file://...), convert to path
        lspServerPath = resolved.startsWith("file://") ? resolved.slice(7) : resolved;
      } else if (typeof require !== "undefined" && typeof require.resolve === "function") {
        lspServerPath = require.resolve("@hypen-space/lsp/src/server.ts");
      }
    } catch {
      // Package not found — studio will run without LSP
    }
    if (!lspServerPath) {
      console.warn(`  ${dim("LSP:")} @hypen-space/lsp not found — editor will run without language features`);
    }
  }

  // On macOS, optionally spawn @hypen-space/ios-streamer so Test Mode can
  // list and mirror iOS simulators. Best-effort: failures are non-fatal.
  let iosStreamerProc: ReturnType<typeof Bun.spawn> | null = null;
  let iosStreamerUrl = "";
  if (process.platform === "darwin") {
    const sidecarPort = studioPort + 1;
    const monorepoStreamer = resolve(dirname(import.meta.dir), "../../hypen-ios-streamer/bin/ios-streamer.ts");
    const useMonorepo = existsSync(monorepoStreamer);
    const cmd = useMonorepo
      ? ["bun", monorepoStreamer, "--port", String(sidecarPort)]
      : ["bunx", "@hypen-space/ios-streamer", "--port", String(sidecarPort)];

    try {
      iosStreamerProc = Bun.spawn({
        cmd,
        env: { ...process.env },
        stdout: "inherit",
        stderr: "inherit",
      });
      iosStreamerUrl = `http://127.0.0.1:${sidecarPort}`;

      const healthOk = await waitForStreamer(iosStreamerUrl, 5000);
      if (!healthOk) {
        console.warn(
          `  ${dim("iOS Streamer:")} started on ${iosStreamerUrl} but /health did not respond within 5s.`
        );
        console.warn(`  ${dim("  Possible causes:")} port in use, Xcode CLT missing, streamer crashed at startup.`);
      }

      iosStreamerProc.exited.then((code) => {
        if (code !== 0 && code !== null) {
          console.warn(`  ${dim("iOS Streamer exited with code")} ${code}${dim(" — iOS cells in Test Mode will be empty until you restart studio.")}`);
        }
      });
    } catch (e: any) {
      console.warn(`  ${dim("iOS Streamer disabled:")} ${e.message}`);
    }
  }

  // Spawn the studio-ui server with environment variables
  const proc = Bun.spawn({
    cmd: ["bun", "--hot", "--preload", resolve(studioUiPath, "hypen-preload.ts"), studioServerPath],
    cwd: studioUiPath,
    env: {
      ...process.env,
      // Bun.serve `development` (Tailwind/HMR) is off when NODE_ENV=production; shells often
      // inherit that after a build, unlike a fresh `bunx` invocation.
      NODE_ENV: "development",
      HYPEN_PROJECT_DIR: cwd,
      HYPEN_COMPONENTS_DIR: options.components,
      HYPEN_ENTRY: options.entry,
      PORT: String(studioPort),
      HYPEN_STUDIO_PORT: String(studioPort),
      HYPEN_SESSION_FILE: sessionFilePath || "",
      HYPEN_REMOTE_URL: options.remoteUrl || "",
      HYPEN_LSP_SERVER: lspServerPath,
      HYPEN_IOS_STREAMER_URL: iosStreamerUrl,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  // Tear down sidecar + studio-ui subprocess when studio exits. Ctrl+C
  // was registering a handler that only killed the streamer — Node/Bun
  // then treated SIGINT as "handled" and *didn't* run the default exit,
  // leaving the studio-ui child (and its RemoteServer sockets) alive so
  // the user saw the banner freeze after "Shutting down…".
  let shuttingDown = false;
  const cleanupAndExit = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (iosStreamerProc && !iosStreamerProc.killed) {
      try { iosStreamerProc.kill(); } catch { /* already dead */ }
    }
    try { proc.kill(); } catch { /* already dead */ }
    // Give subprocesses a moment to flush, then force-exit. Without this
    // process.exit call the handler "consumes" SIGINT and bun never exits.
    setTimeout(() => process.exit(code), 250).unref();
  };
  process.on("exit", () => {
    if (iosStreamerProc && !iosStreamerProc.killed) {
      try { iosStreamerProc.kill(); } catch { /* already dead */ }
    }
  });
  process.on("SIGINT", () => cleanupAndExit(130));
  process.on("SIGTERM", () => cleanupAndExit(143));

  const studioUrl = `http://localhost:${studioPort}`;
  const openUrl = options.testMode ? `${studioUrl}/test-mode` : studioUrl;
  console.log(`  ${pink("Studio running at:")} ${yellow(studioUrl)}`);
  if (options.testMode) {
    console.log(`  ${dim("Test Mode:")}        ${yellow(openUrl)}`);
  }
  console.log(`  ${dim("Press Ctrl+C to stop")}\n`);

  // Open browser. `HYPEN_NO_OPEN=1` opts out — used by integration tests
  // so spawning the studio doesn't fling a real browser tab.
  if (options.open !== false && process.env.HYPEN_NO_OPEN !== "1") {
    const openCmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

    try {
      Bun.spawn([openCmd, openUrl]);
    } catch (e) {
      console.log(`  Open ${openUrl} in your browser`);
    }
  }

  // Wait for the process
  await proc.exited;
}
