import { serve } from "bun";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, watch, mkdirSync, unlinkSync, renameSync, rmSync, copyFileSync, cpSync } from "fs";
import { join, resolve, extname } from "path";
import { tmpdir } from "os";
import {
  listAllDevices,
  androidMjpegStream,
  androidScreenshot,
  androidInput,
  shutdownAndroidDevice,
  bootAndroidAVD,
  bootIOSDevice,
  shutdownIOSDevice,
  iosInput,
  proxyIOSGet,
} from "./server/devices.ts";
import {
  installAndLaunchAndroid,
  installAndLaunchIOS,
} from "../../src/studio/run-device.ts";
import {
  executeScript,
  validateScript,
  type RunScript,
  type RunEvent,
} from "../../src/studio/run-scripts.ts";
import { StudioEngineHost } from "./server/engine-host.ts";

// The `hypen studio` CLI hosts us as a subprocess and passes HYPEN_PROJECT_DIR;
// standalone dev (`bun run dev` inside studio-ui/) doesn't. When the CLI owns
// us we need the Bun.build + tailwindPlugin path — Bun's HTML-import path runs
// without plugins under `bun --hot`, producing zero utility CSS regardless of
// whether we live under node_modules. The earlier `/node_modules/` probe
// caught the bunx case but silently broke monorepo/teleport launches.
const isHostedByCli = Boolean(process.env.HYPEN_PROJECT_DIR);

let serveIndex: any;
let buildAssetsDir: string | null = null;

// Prebuilt bundle shipped inside the published @hypen-space/cli package
// (built by hypen-cli/build.ts at publish time, into the CLI's dist/ so the
// tarball's `dist/` gitignore rule can't strip it). Preferring it over a
// runtime build matters beyond startup speed: published installs live
// under bun's global dir (`~/.bun/install/global/node_modules/...`), and
// Tailwind's source scanner silently skips everything under a hidden
// (dot-)directory — a runtime build there emits CSS with ZERO utility
// classes and Studio renders completely unstyled.
const prebuiltAssetsDir = join(import.meta.dir, "..", "..", "dist", "studio-ui");

if (isHostedByCli) {
  if (existsSync(join(prebuiltAssetsDir, "index.html"))) {
    buildAssetsDir = prebuiltAssetsDir;
  } else {
    // Monorepo / teleport dev: no prebuilt bundle, build on the fly.
    const tailwindPlugin = (await import("bun-plugin-tailwind")).default;
    buildAssetsDir = join(tmpdir(), `hypen-studio-${process.pid}`);

    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.html")],
      outdir: buildAssetsDir,
      plugins: [tailwindPlugin],
      target: "browser",
    });

    if (!result.success) {
      console.error("Studio UI build failed:", result.logs);
      process.exit(1);
    }

    // Surface the hidden-directory Tailwind failure mode instead of
    // serving a silently unstyled Studio.
    const cssArtifact = result.outputs.find((o) => o.path.endsWith(".css"));
    if (cssArtifact && !/\.flex\b/.test(await Bun.file(cssArtifact.path).text())) {
      console.warn(
        "[studio] Tailwind emitted no utility classes — studio-ui is likely under a " +
          "hidden directory (e.g. ~/.bun), which Tailwind's scanner skips. " +
          "Studio will render unstyled. Upgrade @hypen-space/cli (newer builds ship a " +
          "prebuilt Studio UI) or run from a path with no dot-directories."
      );
    }

    // Clean up temp build on exit
    const dir = buildAssetsDir;
    process.on("exit", () => { try { rmSync(dir, { recursive: true }); } catch {} });
  }
} else {
  // Dev mode: use Bun's HTML import for HMR support
  serveIndex = (await import("./index.html")).default;
}

// Get the project directory from environment or use cwd
const projectDir = process.env.HYPEN_PROJECT_DIR || process.cwd();
// Hypen Studio UI lives under studio-ui/. When shipped inside @hypen-space/cli,
// studio-ui's runtime deps (Radix, lucide, …) are hoisted into the CLI's
// node_modules — one level above studio-ui. For local dev in the monorepo,
// studio-ui may also carry its own node_modules. Both are searched.
const studioUiRoot = resolve(import.meta.dir, "..");
const cliRoot = resolve(studioUiRoot, "..");
const componentsDir = process.env.HYPEN_COMPONENTS_DIR || "src/components";
const entryComponent = process.env.HYPEN_ENTRY || "App";
const sessionFilePath = process.env.HYPEN_SESSION_FILE || "";
const remoteUrl = process.env.HYPEN_REMOTE_URL || "";

// Load session data if available
let sessionData: any = null;
if (sessionFilePath && existsSync(sessionFilePath)) {
  try {
    const content = readFileSync(sessionFilePath, "utf-8");
    sessionData = JSON.parse(content);
  } catch (e: any) {
    console.error(`  Failed to load session: ${e.message}`);
  }
}

// Store WebSocket clients for hot reload
const wsClients = new Set<any>();

// Boot the in-studio engine host. Failures are non-fatal — the rest of
// Studio (file browser, editor, Test Mode with local-mode cells) still
// works; only the remote-engine previews / native mirror need it.
const engineHost = new StudioEngineHost({
  projectDir,
  componentsDir,
  entryName: entryComponent,
});
engineHost.start().catch((err) => {
  console.warn(`[engine] failed to start: ${err?.message ?? err}`);
});

// Track terminal processes per WebSocket connection
type WsData = {
  type: "ws" | "terminal" | "lsp" | "device-logs" | "engine" | "run-script";
  proc?: any;
  platform?: "android" | "ios";
  deviceId?: string;
  /** Active run-script execution, if this socket is driving one. Populated
   *  on the first message the client sends (which names the script id). */
  runAbort?: AbortController;
};

// ─── Config helpers ────────────────────────────────────────────────────
//
// hypen.json lives at the project root. We read it on demand (small file,
// no measurable cost) and write back atomically via a temp-file swap so
// Studio can never leave a truncated config if the process dies mid-write.

const HYPEN_JSON_PATH = resolve(projectDir, "hypen.json");

function readConfigSafe(): Record<string, unknown> {
  try {
    if (!existsSync(HYPEN_JSON_PATH)) return {};
    const raw = readFileSync(HYPEN_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  } catch (e: any) {
    console.warn(`[config] read failed: ${e?.message ?? e}`);
    return {};
  }
}

function writeConfig(next: Record<string, unknown>): void {
  const pretty = JSON.stringify(next, null, 2) + "\n";
  const tmp = HYPEN_JSON_PATH + ".tmp";
  writeFileSync(tmp, pretty, "utf-8");
  renameSync(tmp, HYPEN_JSON_PATH);
}

function getRunScripts(): RunScript[] {
  const cfg = readConfigSafe();
  const raw = Array.isArray(cfg.runScripts) ? cfg.runScripts : [];
  const out: RunScript[] = [];
  for (const entry of raw) {
    const v = validateScript(entry);
    if (v) out.push(v);
    else console.warn("[config] skipped invalid runScripts entry");
  }
  return out;
}

/**
 * Get directory tree structure
 */
function getDirectoryTree(dir: string, basePath: string = ""): any[] {
  const items: any[] = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") {
        continue;
      }

      const fullPath = join(dir, entry);
      const relativePath = join(basePath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        items.push({
          name: entry,
          path: relativePath,
          type: "directory",
          children: getDirectoryTree(fullPath, relativePath),
        });
      } else {
        const ext = extname(entry);
        if ([".hypen", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css"].includes(ext)) {
          items.push({
            name: entry,
            path: relativePath,
            type: "file",
            ext: ext,
          });
        }
      }
    }
  } catch (e: any) {
    console.warn(`[Studio] Warning: error reading directory: ${e.message}`);
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Broadcast message to all WebSocket clients
 */
function broadcast(message: any) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    try {
      client.send(data);
    } catch (e) {
      wsClients.delete(client);
    }
  }
}

/**
 * Get MIME type for file extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".ts": "application/typescript",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return mimeTypes[ext] || "text/plain";
}

// Watch for file changes in the project
if (existsSync(resolve(projectDir, componentsDir))) {
  watch(resolve(projectDir, componentsDir), { recursive: true }, (eventType, filename) => {
    if (filename && !filename.includes("node_modules")) {
      broadcast({ type: "reload", file: filename });
      // Hot-patch the engine host so connected cells / runners see the
      // change without a full reconnect.
      engineHost.reload().catch(() => { /* already logged inside */ });
    }
  });
}

const server = serve({
  port: Number(process.env.PORT) || 5173,

  routes: {
    // API Routes - must come before catch-all
    "/api/files": {
      async GET(req) {
        const tree = getDirectoryTree(projectDir);
        return Response.json(tree);
      },
    },

    "/api/project": {
      async GET(req) {
        return Response.json({
          components: componentsDir,
          entry: entryComponent,
          cwd: projectDir,
          remoteUrl: remoteUrl || undefined,
        });
      },
    },

    "/api/session": {
      async GET(req) {
        if (sessionData) {
          return Response.json({ success: true, session: sessionData });
        }
        return Response.json({ success: false, session: null });
      },
    },

    "/api/engine/reset": {
      async POST(req) {
        engineHost.reset();
        return Response.json({ ok: true });
      },
    },

    "/api/engine/status": {
      async GET(req) {
        return Response.json({ ready: engineHost.isReady() });
      },
    },

    // ─── Mock-state controls (only meaningful when the entry has no .ts) ───
    "/api/engine/mock": {
      async GET(req) {
        return Response.json(engineHost.getMockState());
      },
    },

    "/api/engine/mock/state": {
      async POST(req) {
        try {
          const body = await req.json();
          if (!body || typeof body !== "object") {
            return Response.json({ error: "body must be an object" }, { status: 400 });
          }
          engineHost.setMockState(body as Record<string, unknown>);
          return Response.json({ ok: true });
        } catch (e: any) {
          return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },

    "/api/engine/mock/add-row": {
      async POST(req) {
        try {
          const body = await req.json();
          const path = typeof (body as any)?.path === "string" ? (body as any).path : "";
          if (!path) {
            return Response.json({ error: "path required" }, { status: 400 });
          }
          engineHost.addMockArrayRow(path);
          return Response.json({ ok: true });
        } catch (e: any) {
          return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },

    "/api/engine/mock/action": {
      async POST(req) {
        try {
          const body = await req.json();
          const name = typeof (body as any)?.name === "string" ? (body as any).name : "";
          if (!name) {
            return Response.json({ error: "name required" }, { status: 400 });
          }
          engineHost.fireMockAction(name, (body as any)?.payload);
          return Response.json({ ok: true });
        } catch (e: any) {
          return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },

    // ─── hypen.json read/write + run-script listing ──────────────────
    "/api/config": {
      async GET(req) {
        return Response.json(readConfigSafe());
      },
      async PUT(req) {
        try {
          const patch = await req.json();
          if (!patch || typeof patch !== "object") {
            return Response.json({ error: "body must be an object" }, { status: 400 });
          }
          const current = readConfigSafe();
          // Shallow merge — the UI ships a full object, but we don't clobber
          // fields it doesn't know about.
          const next = { ...current, ...(patch as Record<string, unknown>) };
          writeConfig(next);
          return Response.json({ ok: true, config: next });
        } catch (e: any) {
          return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },

    "/api/run-scripts": {
      async GET(req) {
        return Response.json({ scripts: getRunScripts() });
      },
    },

    // Serve the React app for root (catch-all last)
    "/": buildAssetsDir
      ? new Response(Bun.file(join(buildAssetsDir, "index.html")))
      : serveIndex,

    // Standalone iframe mount for Test Mode previews. Same SPA bundle —
    // frontend.tsx branches on window.location.pathname.
    "/preview-frame": buildAssetsDir
      ? new Response(Bun.file(join(buildAssetsDir, "index.html")), {
          headers: { "Content-Type": "text/html" },
        })
      : serveIndex,

    // Pop-out window mount for individual Test Mode cells.
    "/cell-viewer": buildAssetsDir
      ? new Response(Bun.file(join(buildAssetsDir, "index.html")), {
          headers: { "Content-Type": "text/html" },
        })
      : serveIndex,

    // Standalone Test Mode, opened via the toolbar "pop-out" button.
    "/test-mode": buildAssetsDir
      ? new Response(Bun.file(join(buildAssetsDir, "index.html")), {
          headers: { "Content-Type": "text/html" },
        })
      : serveIndex,
  },

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Serve pre-built assets (JS/CSS chunks) when running from node_modules
    if (buildAssetsDir && (pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".js.map"))) {
      const assetPath = join(buildAssetsDir, pathname.slice(1));
      if (existsSync(assetPath) && statSync(assetPath).isFile()) {
        return new Response(Bun.file(assetPath), {
          headers: { "Content-Type": getMimeType(extname(assetPath)) },
        });
      }
    }

    // Handle API file routes
    if (pathname.startsWith("/api/files/") && pathname.length > "/api/files/".length) {
      const filePath = decodeURIComponent(pathname.slice("/api/files/".length));
      const fullPath = resolve(projectDir, filePath);

      // Security: ensure path is within project
      if (!fullPath.startsWith(projectDir)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }

      if (req.method === "GET") {
        if (existsSync(fullPath)) {
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            const content = readFileSync(fullPath, "utf-8");
            return Response.json({ content, path: filePath });
          }
          if (stat.isDirectory()) {
            const tree = getDirectoryTree(fullPath, filePath);
            return Response.json(tree);
          }
        }
        return Response.json({ error: "File not found", path: filePath, fullPath }, { status: 404 });
      }

      if (req.method === "PUT") {
        try {
          const body = await req.json();
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          if (dir && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(fullPath, body.content, "utf-8");
          return Response.json({ success: true });
        } catch (e: any) {
          console.error(`[Studio] File write error: ${e.message}`);
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (req.method === "DELETE") {
        try {
          if (existsSync(fullPath)) {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              rmSync(fullPath, { recursive: true });
            } else {
              unlinkSync(fullPath);
            }
            return Response.json({ success: true });
          }
          return Response.json({ error: "File not found" }, { status: 404 });
        } catch (e: any) {
          console.error(`[Studio] Delete error: ${e.message}`);
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      if (req.method === "PATCH") {
        try {
          const body = await req.json();
          if (body.newPath) {
            const newFullPath = resolve(projectDir, body.newPath);
            if (!newFullPath.startsWith(projectDir)) {
              return Response.json({ error: "Access denied" }, { status: 403 });
            }
            const newDir = newFullPath.substring(0, newFullPath.lastIndexOf("/"));
            if (newDir && !existsSync(newDir)) {
              mkdirSync(newDir, { recursive: true });
            }
            renameSync(fullPath, newFullPath);
            return Response.json({ success: true, newPath: body.newPath });
          }
          return Response.json({ error: "newPath required" }, { status: 400 });
        } catch (e: any) {
          console.error(`[Studio] Rename error: ${e.message}`);
          return Response.json({ error: e.message }, { status: 500 });
        }
      }
    }

    // List .d.ts files in a node_modules package
    if (pathname.startsWith("/api/package-types/") && req.method === "GET") {
      const packageName = decodeURIComponent(pathname.slice("/api/package-types/".length));

      if (!packageName || !packageName.trim()) {
        return Response.json({ error: "Package name required" }, { status: 400 });
      }

      const pkgDir = resolve(projectDir, "node_modules", packageName);

      if (!pkgDir.startsWith(resolve(projectDir, "node_modules"))) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }

      if (!existsSync(pkgDir)) {
        return Response.json({ error: "Package not found" }, { status: 404 });
      }

      const MAX_DTS_FILES = 200;
      const results: { dir: string; files: string[] }[] = [];
      let totalFiles = 0;

      function collectDts(dir: string, base: string, files: string[]) {
        if (totalFiles >= MAX_DTS_FILES) return;
        try {
          for (const entry of readdirSync(dir)) {
            if (totalFiles >= MAX_DTS_FILES) return;
            if (entry === "node_modules") continue;
            const full = join(dir, entry);
            const rel = base ? `${base}/${entry}` : entry;
            const s = statSync(full);
            if (s.isDirectory()) {
              collectDts(full, rel, files);
            } else if (entry.endsWith(".d.ts")) {
              files.push(rel);
              totalFiles++;
            }
          }
        } catch (e: any) {
          console.warn(`[Studio] Warning: failed to scan directory for .d.ts files: ${e.message}`);
        }
      }

      // Scan root-level .d.ts files (e.g., index.d.ts directly in package)
      try {
        for (const entry of readdirSync(pkgDir)) {
          if (totalFiles >= MAX_DTS_FILES) break;
          if (entry.endsWith(".d.ts")) {
            const full = join(pkgDir, entry);
            if (statSync(full).isFile()) {
              results.push({ dir: ".", files: [entry] });
              totalFiles++;
            }
          }
        }
      } catch (e: any) {
        console.warn(`[Studio] Warning: failed to scan package root for .d.ts files: ${e.message}`);
      }

      // Scan common type output subdirectories
      for (const subdir of ["dist", "esm", "lib", "types", "build"]) {
        if (totalFiles >= MAX_DTS_FILES) break;
        const dir = join(pkgDir, subdir);
        if (existsSync(dir)) {
          const files: string[] = [];
          collectDts(dir, "", files);
          if (files.length > 0) {
            results.push({ dir: subdir, files });
          }
        }
      }

      return Response.json({ results });
    }

    // Handle folder creation
    if (pathname.startsWith("/api/folders/") && pathname.length > "/api/folders/".length) {
      const folderPath = decodeURIComponent(pathname.slice("/api/folders/".length));
      const fullPath = resolve(projectDir, folderPath);

      if (!fullPath.startsWith(projectDir)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }

      if (req.method === "POST") {
        try {
          mkdirSync(fullPath, { recursive: true });
          return Response.json({ success: true });
        } catch (e: any) {
          console.error(`[Studio] Folder creation error: ${e.message}`);
          return Response.json({ error: e.message }, { status: 500 });
        }
      }
    }

    // Handle copy operation
    if (pathname === "/api/copy" && req.method === "POST") {
      try {
        const body = await req.json();
        const sourcePath = resolve(projectDir, body.source);
        const destPath = resolve(projectDir, body.destination);

        if (!sourcePath.startsWith(projectDir) || !destPath.startsWith(projectDir)) {
          return Response.json({ error: "Access denied" }, { status: 403 });
        }

        if (!existsSync(sourcePath)) {
          return Response.json({ error: "Source not found" }, { status: 404 });
        }

        const stat = statSync(sourcePath);
        if (stat.isDirectory()) {
          cpSync(sourcePath, destPath, { recursive: true });
        } else {
          const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
          if (destDir && !existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
          }
          copyFileSync(sourcePath, destPath);
        }
        return Response.json({ success: true });
      } catch (e: any) {
        console.error(`[Studio] Copy error: ${e.message}`);
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // ─── Test Mode device API ─────────────────────────────────

    if (pathname === "/api/devices" && req.method === "GET") {
      try {
        const all = await listAllDevices();
        return Response.json(all);
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    const deviceMatch = pathname.match(
      /^\/api\/devices\/(android|ios)\/([^/]+)\/(boot|shutdown|input|screenshot\.png|screenshot\.jpg|stream\.mjpeg|stream\.mp4|run-native)$/
    );
    if (deviceMatch) {
      const platform = deviceMatch[1] as "android" | "ios";
      const id = decodeURIComponent(deviceMatch[2]!);
      const action = deviceMatch[3]!;

      try {
        if (platform === "android") {
          if (action === "shutdown" && req.method === "POST") {
            await shutdownAndroidDevice(id);
            return Response.json({ ok: true });
          }
          if (action === "boot" && req.method === "POST") {
            // Cold AVD entries arrive as id="avd:<name>".
            if (!id.startsWith("avd:")) {
              return Response.json(
                { error: "android_boot_unsupported", message: "Only cold AVDs can be booted from studio." },
                { status: 400 }
              );
            }
            await bootAndroidAVD(id.slice("avd:".length));
            return Response.json({ ok: true });
          }
          if (action === "screenshot.png" && req.method === "GET") {
            const bytes = await androidScreenshot(id);
            return new Response(bytes as BlobPart, {
              headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
            });
          }
          if (action === "stream.mjpeg" && req.method === "GET") {
            const url = new URL(req.url);
            const fps = Number(url.searchParams.get("fps") ?? "8");
            const stream = androidMjpegStream(id, fps, req.signal);
            return new Response(stream, {
              headers: {
                "Content-Type": "multipart/x-mixed-replace; boundary=studioframe",
                "Cache-Control": "no-store",
              },
            });
          }
          if (action === "input" && req.method === "POST") {
            const body = await req.json();
            await androidInput(id, body);
            return Response.json({ ok: true });
          }
          if (action === "run-native" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            const overrideUrl = typeof body?.wsUrl === "string" ? body.wsUrl : undefined;
            const result = await installAndLaunchAndroid(id, overrideUrl);
            if (!result.ok) return Response.json(result, { status: 400 });
            return Response.json(result);
          }
        }

        if (platform === "ios") {
          if (action === "boot" && req.method === "POST") {
            await bootIOSDevice(id);
            return Response.json({ ok: true });
          }
          if (action === "shutdown" && req.method === "POST") {
            await shutdownIOSDevice(id);
            return Response.json({ ok: true });
          }
          if (action === "input" && req.method === "POST") {
            const body = await req.json();
            return iosInput(id, body);
          }
          if (action === "screenshot.jpg" && req.method === "GET") {
            return proxyIOSGet(`/devices/${encodeURIComponent(id)}/screenshot.jpg`, req.signal);
          }
          if (action === "stream.mjpeg" && req.method === "GET") {
            return proxyIOSGet(`/stream/${encodeURIComponent(id)}`, req.signal);
          }
          if (action === "stream.mp4" && req.method === "GET") {
            return proxyIOSGet(`/video/${encodeURIComponent(id)}`, req.signal);
          }
          if (action === "run-native" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            const overrideUrl = typeof body?.wsUrl === "string" ? body.wsUrl : undefined;
            const result = await installAndLaunchIOS(id, overrideUrl);
            if (!result.ok) return Response.json(result, { status: 400 });
            return Response.json(result);
          }
        }

        return Response.json({ error: "unsupported" }, { status: 405 });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // WebSocket upgrade for hot reload
    if (pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { type: "ws" } as any });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade for terminal PTY
    if (pathname === "/ws/terminal") {
      const upgraded = server.upgrade(req, { data: { type: "terminal" } as any });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade for LSP
    if (pathname === "/ws/lsp") {
      const upgraded = server.upgrade(req, { data: { type: "lsp" } as any });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade for the studio-hosted engine (RemoteServer protocol).
    if (pathname === "/ws/engine") {
      const upgraded = server.upgrade(req, { data: { type: "engine" } as any });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Run-script execution channel. Client opens the socket and sends
    // `{ scriptId }` as the first message; the server streams RunEvents
    // until the script completes, then closes. A single WS per run keeps
    // the lifecycle obvious and sidesteps the WS-POST-correlation dance.
    if (pathname === "/ws/run-script") {
      const upgraded = server.upgrade(req, { data: { type: "run-script" } as any });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade for device log tailing
    if (pathname === "/ws/device-logs") {
      const qs = new URL(req.url).searchParams;
      const platform = qs.get("platform") as "android" | "ios" | null;
      const deviceId = qs.get("id");
      if ((platform !== "android" && platform !== "ios") || !deviceId) {
        return new Response("Missing or invalid platform/id", { status: 400 });
      }
      const upgraded = server.upgrade(req, {
        data: { type: "device-logs", platform, deviceId } as any,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Serve node_modules for (1) Monaco / editor: project deps, (2) Bun dev chunks: studio-ui deps.
    // Teleported projects only depend on @hypen-space/* — they do not contain lucide, Radix, etc.
    // If we only looked at projectDir, many /node_modules/* requests would miss and hit the SPA
    // fallback (HTML as 200), which breaks the shell with few visible console errors.
    if (pathname.startsWith("/node_modules/")) {
      const tryServeFromRoot = (root: string): Response | null => {
        const filePath = join(root, pathname);
        const tryPaths = [filePath];
        if (!extname(pathname)) {
          tryPaths.push(filePath + ".js");
          tryPaths.push(join(filePath, "index.js"));
        }
        for (const tryPath of tryPaths) {
          if (existsSync(tryPath) && statSync(tryPath).isFile()) {
            const content = readFileSync(tryPath);
            const ext = extname(tryPath);
            return new Response(content, {
              headers: {
                "Content-Type": getMimeType(ext),
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }
        return null;
      };

      const fromProject = tryServeFromRoot(projectDir);
      if (fromProject) return fromProject;

      const fromStudio = tryServeFromRoot(studioUiRoot);
      if (fromStudio) return fromStudio;

      // Fall back to the CLI root: when installed via npm/bunx, studio-ui's
      // deps are hoisted up one level.
      const fromCli = tryServeFromRoot(cliRoot);
      if (fromCli) return fromCli;

      return new Response("Not found", { status: 404 });
    }

    // Favicon is embedded as data URL in HTML, return empty for .ico requests
    if (pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Taffy layout WASM — the canvas renderer fetches /taffy_wasm_bg.wasm at
    // origin because Bun's bundler inlines a file:// URL for import.meta.url
    // inside taffy_wasm.js, which the browser blocks.
    if (pathname === "/taffy_wasm_bg.wasm") {
      const candidates = [
        join(studioUiRoot, "node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm"),
        join(cliRoot, "node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm"),
        join(projectDir, "node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm"),
      ];
      for (const p of candidates) {
        if (existsSync(p) && statSync(p).isFile()) {
          return new Response(Bun.file(p), {
            headers: { "Content-Type": "application/wasm" },
          });
        }
      }
      return new Response("taffy wasm not found", { status: 404 });
    }

    // Asset-like paths that reached here are misses — serving HTML with a
    // 200 + text/html would trip the browser's strict MIME check for module
    // scripts ("Expected a JavaScript-or-Wasm module script…") and break
    // unrelated features that silently depended on the asset resolving.
    const assetExt = extname(pathname);
    if (assetExt && assetExt !== ".html" && assetExt !== ".htm") {
      return new Response(`Not found: ${pathname}`, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // SPA fallback — serve the app for any unmatched route
    const fallbackHtml = buildAssetsDir
      ? join(buildAssetsDir, "index.html")
      : join(import.meta.dir, "index.html");
    return new Response(Bun.file(fallbackHtml), {
      headers: { "Content-Type": "text/html" },
    });
  },

  websocket: {
    open(ws) {
      const wsData = ws.data as unknown as WsData;

      if (wsData.type === "engine") {
        // Hand the socket off to StudioEngineHost which spins up a
        // RemoteSession bound to this connection.
        engineHost.attachSession(ws as any);
        return;
      }

      if (wsData.type === "terminal") {
        // Spawn a shell with a PTY via Bun.Terminal
        const shell = process.env.SHELL || "/bin/zsh";
        try {
          const proc = Bun.spawn([shell, "-li"], {
            cwd: projectDir,
            env: {
              ...process.env,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            },
            terminal: {
              cols: 80,
              rows: 24,
              data(_terminal: any, data: any) {
                try {
                  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
                  ws.send(JSON.stringify({ type: "output", data: text }));
                } catch (e) {
                  // WebSocket may be closed
                }
              },
            },
          });
          wsData.proc = proc;

          proc.exited.then((code: number) => {
            try {
              ws.send(JSON.stringify({ type: "exit", code }));
            } catch (e) {
              // WebSocket may be closed
            }
          });

        } catch (e: any) {
          console.error(`  Failed to start terminal: ${e.message}`);
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        }
        return;
      }

      if (wsData.type === "device-logs") {
        const { platform, deviceId } = wsData;
        if (!platform || !deviceId) {
          try { ws.close(1008, "missing platform/id"); } catch {}
          return;
        }
        const cmd = platform === "android"
          ? ["adb", "-s", deviceId, "logcat", "-v", "brief"]
          : [
              "xcrun", "simctl", "spawn", deviceId,
              "log", "stream",
              "--level", "debug",
              "--style", "compact",
            ];
        try {
          const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
          wsData.proc = proc;

          const pump = async (stream: ReadableStream<Uint8Array>) => {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, idx);
                  buf = buf.slice(idx + 1);
                  try { ws.send(line); } catch { return; }
                }
              }
              if (buf) { try { ws.send(buf); } catch {} }
            } catch (e: any) {
              try { ws.send(`[log stream ended: ${e?.message ?? e}]`); } catch {}
            }
          };

          pump(proc.stdout as ReadableStream<Uint8Array>);
          pump(proc.stderr as ReadableStream<Uint8Array>);

          proc.exited.then((code) => {
            try { ws.send(`[process exited with code ${code}]`); } catch {}
            try { ws.close(); } catch {}
          });
        } catch (e: any) {
          try { ws.send(`[failed to spawn: ${e?.message ?? e}]`); } catch {}
          try { ws.close(); } catch {}
        }
        return;
      }

      if (wsData.type === "lsp") {
        // LSP server path is resolved by the CLI and passed via env var
        const serverPath = process.env.HYPEN_LSP_SERVER;
        if (!serverPath) {
          ws.close(1011, "LSP server not available");
          return;
        }
        const lspDir = resolve(serverPath, "..");
        try {
          const proc = Bun.spawn(["bun", "run", serverPath, "--stdio"], {
            cwd: lspDir,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          wsData.proc = proc;

          // Pipe stdout (Content-Length framed) → WebSocket (raw JSON)
          (async () => {
            let buffer = Buffer.alloc(0);
            const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer = Buffer.concat([buffer, Buffer.from(value)]);

                // Extract complete LSP messages from buffer
                while (true) {
                  const headerEnd = buffer.indexOf("\r\n\r\n");
                  if (headerEnd === -1) break;

                  const header = buffer.slice(0, headerEnd).toString();
                  const match = header.match(/Content-Length:\s*(\d+)/i);
                  if (!match) {
                    buffer = buffer.slice(headerEnd + 4);
                    continue;
                  }

                  const contentLength = parseInt(match[1], 10);
                  const messageStart = headerEnd + 4;
                  const messageEnd = messageStart + contentLength;

                  if (buffer.length < messageEnd) break; // wait for more data

                  const body = buffer.slice(messageStart, messageEnd).toString();
                  buffer = buffer.slice(messageEnd);

                  try {
                    ws.send(body);
                  } catch (e: any) {
                    console.warn(`[LSP] WebSocket send failed: ${e.message}`);
                    return;
                  }
                }
              }
            } catch (e: any) {
              console.warn(`[LSP] stdout stream ended: ${e.message ?? "unknown"}`);
            }
          })();

          // Forward stderr only when it contains an actual error (starts with a level tag).
          (async () => {
            const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const line = Buffer.from(value).toString().trimEnd();
                if (/\b(error|fatal|panic)\b/i.test(line)) {
                  console.error(`[LSP] ${line}`);
                }
              }
            } catch (e: any) {
              console.warn(`[LSP] stderr stream ended: ${e.message ?? "unknown"}`);
            }
          })();

          proc.exited.then((code: number) => {
            try { ws.close(); } catch (e: any) { console.warn(`[LSP] ws.close() failed: ${e.message}`); }
          });

        } catch (e: any) {
          console.error(`  Failed to start LSP server: ${e.message}`);
          ws.close();
        }
        return;
      }

      wsClients.add(ws);
    },
    close(ws) {
      const wsData = ws.data as unknown as WsData;

      if (wsData.type === "engine") {
        engineHost.onClose(ws as any);
        return;
      }

      if (wsData.type === "run-script") {
        // Mid-run disconnect means the client walked away — abort so we
        // don't keep spawning gallery installs into the void.
        if (wsData.runAbort) wsData.runAbort.abort();
        return;
      }

      if (wsData.type === "terminal") {
        if (wsData.proc) {
          try {
            wsData.proc.kill();
            wsData.proc.terminal?.close();
          } catch (e) {
            // Process may already be dead
          }
        }
        return;
      }

      if (wsData.type === "lsp") {
        if (wsData.proc) {
          try {
            wsData.proc.stdin.end();
            wsData.proc.kill();
          } catch (e: any) {
            console.warn(`[LSP] cleanup failed (process may already be dead): ${e.message}`);
          }
        }
        return;
      }

      if (wsData.type === "device-logs") {
        if (wsData.proc) {
          try { wsData.proc.kill(); } catch { /* already dead */ }
        }
        return;
      }

      wsClients.delete(ws);
    },
    message(ws, message) {
      const wsData = ws.data as unknown as WsData;

      if (wsData.type === "engine") {
        engineHost.onMessage(ws as any, message as any);
        return;
      }

      if (wsData.type === "run-script") {
        // First message carries `{ scriptId }`. Subsequent messages are
        // either `{ cancel: true }` to abort, or ignored. Starting on the
        // client's nod (rather than on upgrade) means the UI can bail out
        // before commitment if it changes its mind post-connect.
        try {
          const msg = JSON.parse(message.toString());
          if (msg.cancel && wsData.runAbort) {
            wsData.runAbort.abort();
            return;
          }
          if (typeof msg.scriptId === "string" && !wsData.runAbort) {
            const script = getRunScripts().find((s) => s.id === msg.scriptId);
            if (!script) {
              try { ws.send(JSON.stringify({ type: "script-error", scriptId: msg.scriptId, msg: "script not found" })); } catch {}
              try { ws.close(); } catch {}
              return;
            }
            const abort = new AbortController();
            wsData.runAbort = abort;
            (async () => {
              const gen = executeScript(script, { projectDir, signal: abort.signal });
              try {
                for await (const event of gen) {
                  try { ws.send(JSON.stringify(event)); } catch { break; }
                }
              } catch (e: any) {
                try { ws.send(JSON.stringify({ type: "script-error", scriptId: script.id, msg: e?.message ?? String(e) })); } catch {}
              } finally {
                try { ws.close(); } catch {}
              }
            })();
          }
        } catch (e: any) {
          console.warn(`[run-script] malformed message: ${e?.message ?? e}`);
        }
        return;
      }

      if (wsData.type === "terminal") {
        try {
          const msg = JSON.parse(message.toString());
          if (msg.type === "input" && wsData.proc?.terminal) {
            wsData.proc.terminal.write(msg.data);
          } else if (msg.type === "resize" && wsData.proc?.terminal) {
            wsData.proc.terminal.resize(msg.cols, msg.rows);
          }
        } catch (e: any) {
          console.warn(`[Studio] Malformed terminal message: ${e.message}`);
        }
        return;
      }

      if (wsData.type === "lsp") {
        if (wsData.proc?.stdin) {
          try {
            const json = message.toString();
            const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
            wsData.proc.stdin.write(header + json);
            wsData.proc.stdin.flush();
          } catch (e: any) {
            console.warn(`[LSP] stdin write failed (may be closed): ${e.message}`);
          }
        }
        return;
      }

      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (e: any) {
        console.warn(`[Studio] Failed to parse WebSocket message: ${e.message}`);
      }
    },
  },

  // Studio is always a local dev server. Tying this to NODE_ENV breaks Tailwind/HMR when
  // the parent shell still has NODE_ENV=production (e.g. after a build) — no 404s, just
  // missing utility CSS and broken layout.
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Hypen Studio running at ${server.url}`);
