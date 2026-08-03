#!/usr/bin/env bun
/**
 * Hypen CLI
 *
 * Works with both Bun and Node.js runtimes.
 *
 * Commands:
 *   hypen init [name]    Initialize a new Hypen project
 *   hypen dev            Start development server
 *   hypen build          Build for production
 *   hypen generate       Generate component imports
 *   hypen run            Install and launch on device/simulator
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { pink, yellow, dim, boldPink, boldYellow } from "../src/colors.js";
import { promptSkillChoice, installSkills, ensureGitignoreSkillEntries } from "../src/skills.js";
import { renderBanner } from "../src/banner.js";
import { maybeRunOnboarding } from "../src/onboarding.js";
import { promptLanguage, promptModuleLayout, type Language } from "../src/init/prompts.js";
import {
  generateTypescriptProject,
  buildTsPackageJson,
} from "../src/init/typescript.js";
import { generateGoProject } from "../src/init/go.js";
import { generateKotlinProject } from "../src/init/kotlin.js";

/**
 * Detect runtime
 */
const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Read version from package.json.
 *
 * Walks up from this file looking for the nearest package.json that
 * names `@hypen-space/cli`. From source, that's one level up
 * (`bin/hypen.ts` → repo root). From the published bundle, it's two
 * (`dist/bin/hypen.js` → package root), since the build doesn't copy
 * package.json into dist/.
 */
function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    let dir = dirname(__filename);
    for (let i = 0; i < 6 && dir !== "/" && dir !== "."; i++) {
      const pkgPath = resolve(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg?.name === "@hypen-space/cli" && pkg.version) return pkg.version;
        } catch {}
      }
      dir = dirname(dir);
    }
  } catch {}

  return "0.0.0";
}

const VERSION = getVersion();

const HELP = `${renderBanner(VERSION, "Declarative UI framework CLI")}
  ${boldYellow("Usage:")}
    hypen <command> [options]

  ${boldYellow("Commands:")}
    ${pink("init")} [name]     Create a new Hypen project
    ${pink("dev")}             Start development server
    ${pink("build")}           Build for production
    ${pink("generate")}        Generate component imports
    ${pink("studio")}          Open Hypen Studio IDE
    ${pink("test")}            Open Studio Test Mode (live previews + device mirrors)
    ${pink("run")} <platform>  Install and launch on device (android|ios)

  ${boldYellow("Options:")}
    -h, --help      Show this help message
    -v, --version   Show version number
    --studio        Open Studio alongside device runner (with run command)

  ${boldYellow("Examples:")}
    ${dim("$")} hypen init my-app
    ${dim("$")} hypen dev --port 3000
    ${dim("$")} hypen build --minify
    ${dim("$")} hypen studio --port 5173
    ${dim("$")} hypen test
    ${dim("$")} hypen run android
    ${dim("$")} hypen run android --url ws://localhost:3000
    ${dim("$")} hypen run ios --studio
`;

interface Config {
  components: string;
  entry: string;
  port?: number;
  outDir?: string;
}

async function loadConfig(): Promise<Config> {

  // Try hypen.json
  const configJsonPath = resolve("hypen.json");
  if (existsSync(configJsonPath)) {
    try {
      const raw = readFileSync(configJsonPath, "utf-8");
      const config = JSON.parse(raw);
      const parsedConfig: Config = {
        components: config.components || "./src/components",
        entry: config.entry || "App",
        port: config.port,
        outDir: config.outDir || config.build?.outDir,
      };
      // Validate port from config file
      if (parsedConfig.port !== undefined) {
        const portError = validatePort(parsedConfig.port);
        if (portError) {
          console.error(`\n  Error in hypen.json: ${portError}\n`);
          process.exit(1);
        }
      }
      return parsedConfig;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SyntaxError) {
        console.error(`\n  Error parsing hypen.json: ${msg}\n`);
      } else {
        console.error(`\n  Error loading hypen.json: ${msg}\n`);
      }
      process.exit(1);
    }
  }

  // Default config
  return {
    components: "./src/components",
    entry: "App",
    port: 3000,
    outDir: "dist",
  };
}

/**
 * Validate a port number
 */
function validatePort(port: number): string | null {
  if (isNaN(port) || !Number.isInteger(port)) {
    return "Port must be a valid integer";
  }
  if (port < 1 || port > 65535) {
    return "Port must be between 1 and 65535";
  }
  return null;
}

/**
 * Validate a project name
 */
function validateProjectName(name: string): string | null {
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    return `Invalid project name "${name}": contains special characters`;
  }
  if (name.startsWith(".") || name.startsWith("-")) {
    return `Invalid project name "${name}": cannot start with "." or "-"`;
  }
  if (name.length > 214) {
    return `Invalid project name "${name}": too long (max 214 characters)`;
  }
  return null;
}

/**
 * Initialize a new project
 */
async function initProject(name?: string) {
  const projectDir = name ? resolve(name) : process.cwd();
  const projectName = name || "hypen-app";

  // Validate project name
  if (name) {
    const nameError = validateProjectName(name);
    if (nameError) {
      console.error(`\n  ${nameError}\n`);
      process.exit(1);
    }
  }

  // Render banner once per invocation so the user sees the Hypen wordmark
  // before any prompts fire.
  console.log(renderBanner(VERSION));
  console.log(`  ${boldPink("Creating Hypen project:")} ${yellow(projectName)}`);

  // Ask for language + module layout up front, *before* creating any
  // files — otherwise choosing Go/Kotlin mid-scaffold would leave a
  // half-TypeScript directory behind.
  const language: Language = await promptLanguage();
  const layout = await promptModuleLayout();

  console.log(`\n  ${dim("Language:")}      ${yellow(language)}`);
  console.log(`  ${dim("Module layout:")} ${yellow(layout)}\n`);

  // Create the project root before any generator runs.
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    console.log(`  ${dim("Created:")} ${projectDir}`);
  }

  // Dispatch to the language-specific generator. Each generator writes
  // a complete runnable scaffold (package manifests, config, modules,
  // UI templates, README as appropriate).
  if (language === "typescript") {
    generateTypescriptProject({ projectDir, projectName, layout });
  } else if (language === "go") {
    generateGoProject({ projectDir, projectName, layout });
  } else if (language === "kotlin") {
    generateKotlinProject({ projectDir, projectName, layout });
  }

  // Offer AI agent skill installation for every language — the skill
  // describes the DSL which is language-agnostic.
  const skillChoice = await promptSkillChoice();
  if (skillChoice !== "none") {
    installSkills(projectDir, skillChoice);
  }

  // Resolve SDK dependencies using each ecosystem's installer.
  if (language === "typescript") {
    // package.json pins @hypen-space/* to "latest"; bun/npm install resolves it.
    const pm = isBun ? "bun" : "npm";
    console.log(`\n  ${dim("Installing dependencies...")}`);
    try {
      if (isBun) {
        const install = Bun.spawnSync([pm, "install"], {
          cwd: projectDir,
          stdout: "inherit",
          stderr: "inherit",
        });
        if (install.exitCode !== 0) {
          console.error(`\n  Failed to install dependencies. Run ${dim(`${pm} install`)} manually.\n`);
        }
      } else {
        execSync(`${pm} install`, { cwd: projectDir, stdio: "inherit" });
      }
    } catch {
      console.error(`\n  Failed to install dependencies. Run ${dim(`${pm} install`)} manually.\n`);
    }
  } else if (language === "go") {
    // go.mod ships without a hypen require; `go mod tidy` reads the import
    // in main.go and pins the latest published github.com/hypen-space/core.
    console.log(`\n  ${dim("Resolving Go modules...")}`);
    try {
      execSync("go mod tidy", { cwd: projectDir, stdio: "inherit" });
    } catch {
      console.error(`\n  Failed to resolve modules. Run ${dim("go mod tidy")} manually.\n`);
    }
  }
  // Kotlin resolves space.hypen:hypen-kotlin (latest.release) from Maven
  // Central on the first `./gradlew build`/`run`; nothing to install here.

  const nextCommand =
    language === "typescript" ? "hypen dev"
    : language === "go" ? "go run ."
    : "./gradlew run";

  console.log(`
  ${boldPink("Done!")} To get started:

    ${name ? `${dim("$")} cd ${name}\n    ` : ""}${dim("$")} ${nextCommand}
`);
}

/**
 * Ensure the current directory is a Hypen project with dependencies
 * installed. Writes a `package.json` using the canonical TS shape when
 * the directory looks like a Hypen project (config file or
 * `src/components`) but `package.json` is missing — typically after a
 * teleport that only shipped source files.
 */
async function ensureProjectDeps() {
  const packageJsonPath = resolve("package.json");
  if (existsSync(packageJsonPath)) return;

  // Only scaffold if this looks like an existing Hypen project without package.json
  const hasConfig = existsSync(resolve("hypen.json"));
  const hasComponents = existsSync(resolve("src/components"));
  if (!hasConfig && !hasComponents) {
    console.error("\n  Error: Not a Hypen project (no hypen.json or src/components/ found).");
    console.error("  Run `hypen init` to create a new project, or `cd` into an existing one.\n");
    process.exit(1);
  }

  console.log("  No package.json found, creating one...");
  const projectName = basename(resolve(".")) || "hypen-app";
  writeFileSync(packageJsonPath, buildTsPackageJson(projectName));

  console.log("  Installing dependencies...");
  const pm = isBun ? "bun" : "npm";
  try {
    if (isBun) {
      const install = Bun.spawnSync([pm, "install"], {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
      });
      if (install.exitCode !== 0) {
        console.error("  Failed to install dependencies.");
        process.exit(1);
      }
    } else {
      execSync(`${pm} install`, { cwd: process.cwd(), stdio: "inherit" });
    }
  } catch {
    console.error("  Failed to install dependencies.");
    process.exit(1);
  }
  console.log("");
}

async function devServer(options: { port?: number; debug?: boolean }) {
  await ensureProjectDeps();
  const config = await loadConfig();
  const { dev } = await import("../src/dev.js");

  await dev({
    components: config.components,
    entry: config.entry,
    port: options.port || config.port || 3000,
    debug: options.debug || false,
    hot: true,
  });
}

/**
 * Build for production
 */
async function buildProject(options: {
  outDir?: string;
  minify?: boolean;
  sourcemap?: boolean;
}) {
  const config = await loadConfig();
  const { build } = await import("../src/dev.js");

  await build({
    components: config.components,
    entry: config.entry,
    outDir: options.outDir || config.outDir || "dist",
    minify: options.minify ?? true,
    sourcemap: options.sourcemap ?? false,
  });
}

/**
 * Generate component imports
 */
async function generateComponents() {
  const config = await loadConfig();
  const { generateComponentsCode } = await import(
    "@hypen-space/server"
  );

  const code = await generateComponentsCode(config.components);
  const outputPath = resolve(".hypen/components.generated.ts");

  const outputDir = resolve(".hypen");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, code);
  console.log(`\n  ${pink("Generated:")} ${outputPath}\n`);
}

/**
 * Fetch session data from API
 */
async function fetchSession(sessionId: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`https://hypen.space/api/sessions?id=${sessionId}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.success && data.data) {
      return data.data;
    }
    console.error(`  Session not found or expired: ${sessionId}`);
    return null;
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.error(`  Session fetch timed out after 15s — is the API reachable?`);
    } else {
      console.error(`  Failed to fetch session: ${e.message}`);
    }
    return null;
  }
}

/**
 * Start Hypen Studio
 */
async function startStudio(options: { port?: number; open?: boolean; session?: string }) {
  const { studio } = await import("../src/studio/server.js");

  // Fetch session data and scaffold project if provided
  let sessionData = null;
  if (options.session) {
    console.log(`\n  ${dim("Fetching session:")} ${options.session}...`);
    sessionData = await fetchSession(options.session);
    if (sessionData) {
      console.log(`  ${pink("Session loaded:")} ${sessionData.example} example`);

      // Scaffold a fresh file-based TypeScript project at hypen-<sessionId>.
      // Teleported sessions always start from the canonical TypeScript
      // template — no language prompt, no layout prompt.
      const projectDir = resolve(`hypen-${options.session}`);
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
        console.log(`  ${dim("Created project:")} ${projectDir}`);

        generateTypescriptProject({
          projectDir,
          projectName: `hypen-${options.session}`,
          layout: "file-based",
        });

        // Install dependencies (mirrors `hypen init`, but unconditional
        // because teleport is always interactive-enough to wait).
        console.log("  Installing dependencies...");
        const pm = isBun ? "bun" : "npm";
        try {
          if (isBun) {
            const install = Bun.spawnSync([pm, "install"], {
              cwd: projectDir,
              stdout: "inherit",
              stderr: "inherit",
            });
            if (install.exitCode !== 0) {
              console.error("  Failed to install dependencies.");
              process.exit(1);
            }
          } else {
            execSync(`${pm} install`, { cwd: projectDir, stdio: "inherit" });
          }
        } catch {
          console.error("  Failed to install dependencies.");
          process.exit(1);
        }

        // Auto-install AI agent skills for teleported projects.
        installSkills(projectDir, "agents");
        ensureGitignoreSkillEntries(projectDir);
      }

      process.chdir(projectDir);
    }
  }

  const config = await loadConfig();
  const projectDirName = options.session ? `hypen-${options.session}` : null;

  await studio({
    components: config.components,
    entry: config.entry,
    port: options.port || 5173,
    open: options.open ?? true,
    session: sessionData,
  });

  if (projectDirName) {
    console.log(`\n  ${pink("Your project is at:")} ${projectDirName}/`);
    console.log(`\n  To continue working:\n    ${dim("$")} cd ${projectDirName}\n    ${dim("$")} hypen dev\n`);
  }
}

/**
 * Handle test command: hypen test
 *
 * Opens Studio directly into Test Mode (the multi-surface preview window).
 * If the current directory is a Hypen project, a RemoteServer is started for
 * the project's entry module and its `ws://` URL is wired through to the
 * Connect input so the previews come up populated. Otherwise Studio opens in
 * connect-only mode — the user can type any `ws://hypen-dev-url` and connect.
 */
async function testMode(options: { port?: number; open?: boolean }) {
  const { studio } = await import("../src/studio/server.js");

  const hasConfig = existsSync(resolve("hypen.json"));
  const hasComponents = existsSync(resolve("src/components"));
  const isProject = hasConfig || hasComponents;

  let remoteWsUrl = "";
  let stopRemoteServer: (() => void) | null = null;
  let stopWatcher: (() => void) | null = null;
  let components = "./src/components";
  let entry = "App";

  if (isProject) {
    const config = await loadConfig();
    components = config.components;
    entry = config.entry;
    const requestedPort = options.port || config.port || 3000;

    // Server-based projects manage their own RemoteServer inside the entry
    // script — detected by a file-extension entry. Don't try to spin up a
    // competing one; just open Studio and let the user point Test Mode at
    // their running `hypen dev`.
    const isServerBased = /\.(ts|js|mjs)$/.test(config.entry);
    if (isServerBased) {
      console.log(
        `  ${dim("Server-based project — start it separately with")} ${yellow("hypen dev")} ${dim("and reconnect from the toolbar.")}`
      );
    } else {
    try {
      const { RemoteServer } = await import("@hypen-space/server/remote");
      const { discoverComponents, loadDiscoveredComponents, watchComponents } = await import(
        "@hypen-space/server"
      );
      const { configureLogger } = await import("@hypen-space/core");

      const componentsDir = resolve(config.components || "./src/components");
      const discovered = await discoverComponents(componentsDir);
      const loaded = await loadDiscoveredComponents(discovered);
      const entryComponent = loaded.get(entry);

      if (!entryComponent?.module) {
        console.log(
          `  ${dim("No usable entry module")} ${dim("(\"" + entry + "\" missing or has no module) —")} ${dim("Studio will open in connect-only mode.")}`
        );
      } else {
        // Suppress framework logs while we boot the server — keeps the
        // banner clean even when the engine is chatty on startup.
        configureLogger({ level: "error" });

        const remoteServer = new RemoteServer()
          .module(entry, entryComponent.module)
          .source(componentsDir)
          .syncActions();

        let actualPort = requestedPort;
        const maxRetries = 10;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            await remoteServer.listen(actualPort);
            break;
          } catch (err: any) {
            if (err?.code === "EADDRINUSE" && attempt < maxRetries) {
              actualPort = requestedPort + attempt + 1;
              continue;
            }
            throw err;
          }
        }
        remoteWsUrl = `ws://localhost:${actualPort}`;
        console.log(`  ${dim("Module:")}     ${entry}`);
        console.log(`  ${dim("Server:")}     ${yellow(remoteWsUrl)}`);
        stopRemoteServer = () => remoteServer.stop();

        // Mirror `hypen dev`: watch the components dir and hot-reload
        // every connected preview (web cells + native runners) when a
        // `.hypen` or sibling module file changes.
        let isInitialScan = true;
        const watcher = watchComponents(componentsDir, {
          onChange: async () => {
            if (isInitialScan) {
              isInitialScan = false;
              return;
            }
            try {
              await remoteServer.reload();
            } catch (e: any) {
              console.warn(`  ${dim("Hot reload failed:")} ${e?.message ?? e}`);
            }
          },
        });
        stopWatcher = () => watcher.stop();

        configureLogger({ level: "info" });
      }
    } catch (err: any) {
      console.warn(
        `  ${dim("Could not start preview server:")} ${err?.message ?? err}`
      );
      console.log(`  ${dim("Studio will open in connect-only mode.")}`);
    }
    }
  } else {
    console.log(
      `  ${dim("Not inside a Hypen project — opening Studio in connect-only mode.")}`
    );
    console.log(
      `  ${dim("Tip: type a")} ${yellow("ws://...")} ${dim("URL into the Connect input to attach to a remote dev server.")}`
    );
  }

  const cleanup = () => {
    if (stopWatcher) {
      try { stopWatcher(); } catch { /* already stopped */ }
      stopWatcher = null;
    }
    if (stopRemoteServer) {
      try { stopRemoteServer(); } catch { /* already stopped */ }
      stopRemoteServer = null;
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  await studio({
    components,
    entry,
    port: 5173,
    open: options.open ?? true,
    remoteUrl: remoteWsUrl || undefined,
    testMode: true,
  });

  cleanup();
}

/**
 * Handle run command: hypen run android|ios
 *
 * Starts the dev server, installs/launches the runner app on the device,
 * and keeps the server running until the user presses Ctrl+C.
 */
async function handleRun(
  platform: string | undefined,
  options: { port?: number; url?: string; studio?: boolean; clean?: boolean }
) {
  const { runAndroid, runIOS, cleanRunners, RUN_HELP } = await import("../src/run.js");
  const config = await loadConfig();
  const port = options.port || config.port || 3000;

  if (!platform || (platform !== "android" && platform !== "ios")) {
    if (platform) {
      console.error(`\n  Unknown platform: ${platform}\n`);
    }
    console.log(RUN_HELP);
    process.exit(platform ? 1 : 0);
  }

  // Clean cached runners if --clean flag is set
  if (options.clean) {
    cleanRunners(platform as "android" | "ios");
  }

  // --url mode: skip built-in server, just install and launch the runner
  // pointing at an existing server
  if (options.url) {
    console.log(`\n  ${boldPink("Hypen Run")} ${dim("-")} ${yellow(platform === "android" ? "Android" : "iOS")}\n`);
    console.log(`  ${dim("Connecting to:")} ${yellow(options.url)}\n`);

    switch (platform) {
      case "android":
        await runAndroid(port, options.url);
        break;
      case "ios":
        await runIOS(port, options.url);
        break;
    }

    // Keep process alive to allow reconnection
    console.log(`  ${pink("Runner launched.")} ${dim("Press Ctrl+C to stop.")}\n`);
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    return;
  }

  // Ensure package.json exists (e.g., after teleport creates only component files)
  await ensureProjectDeps();

  // Use RemoteServer (WebSocket) for native clients instead of HTTP dev server
  const { RemoteServer } = await import("@hypen-space/server/remote");
  const { discoverComponents, loadDiscoveredComponents, watchComponents } = await import(
    "@hypen-space/server"
  );

  const componentsDir = resolve(config.components || "./src/components");
  const entryName = config.entry || "App";

  // Discover and load components
  const discovered = await discoverComponents(componentsDir);
  const loaded = await loadDiscoveredComponents(discovered);

  const entry = loaded.get(entryName);
  if (!entry) {
    console.error(`\n  Entry component "${entryName}" not found in ${componentsDir}\n`);
    console.error(`  Available components: ${Array.from(loaded.keys()).join(", ") || "(none)"}`);
    process.exit(1);
  }

  if (!entry.module) {
    console.error(`\n  Entry component "${entryName}" has no module definition.`);
    console.error(`  Ensure ${entryName}.ts has a default export using app.defineState(...).build()\n`);
    process.exit(1);
  }

  console.log(`  ${dim("Module:")}     ${entryName} (${entry.module.name || "anonymous"})`);
  console.log(`  ${dim("Template:")}   ${entry.template ? entry.template.substring(0, 60) + "..." : "(empty)"}`)

  // Suppress framework logs during runner setup so device picker is visible
  const { configureLogger } = await import("@hypen-space/core");
  configureLogger({ level: "error" });

  // Start the WebSocket server (quietly)
  const remoteServer = new RemoteServer()
    .module(entryName, entry.module)
    .source(componentsDir)
    .onConnection((client) => {
      console.log(`  ${pink("Device connected:")} ${client.id}`);
    })
    .onDisconnection((client) => {
      console.log(`  ${dim("Device disconnected:")} ${client.id}`);
    });

  // Sync actions across all clients when running with Studio
  if (options.studio) {
    remoteServer.syncActions();
  }

  let actualPort = port;
  const maxRetries = 10;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await remoteServer.listen(actualPort);
      break;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" && attempt < maxRetries) {
        actualPort = port + attempt + 1;
        console.log(`  ${dim(`Port ${actualPort - 1} in use, trying ${actualPort}...`)}`);
        continue;
      }
      throw err;
    }
  }
  console.log(`  ${dim("Server:")}     ws://0.0.0.0:${actualPort}`);

  // Install and launch the runner app (before Studio, so interactive
  // prompts and download output are visible without interleaving)
  switch (platform) {
    case "android":
      console.log(`\n  ${boldPink("Hypen Run")} ${dim("-")} ${yellow("Android")}\n`);
      await runAndroid(actualPort);
      break;

    case "ios":
      console.log(`\n  ${boldPink("Hypen Run")} ${dim("-")} ${yellow("iOS")}\n`);
      await runIOS(actualPort);
      break;
  }

  // Restore normal log level now that runner setup is done
  configureLogger({ level: "info" });

  // Start Studio alongside if --studio flag is set
  if (options.studio) {
    const studioPort = 5173;
    const remoteWsUrl = `ws://localhost:${actualPort}`;
    console.log(`  ${pink("Starting Studio...")} ${dim(`(connected to ${remoteWsUrl})`)}`);

    // Fire-and-forget: studio runs in parallel
    const { studio: startStudioServer } = await import("../src/studio/server.js");
    startStudioServer({
      components: config.components,
      entry: config.entry,
      port: studioPort,
      open: true,
      remoteUrl: remoteWsUrl,
    }).catch((e: any) => {
      console.error(`  Studio error: ${e.message}`);
    });
  }

  // Watch for file changes and hot-reload all connected clients
  let isInitialScan = true;
  const watcher = watchComponents(componentsDir, {
    onChange: async () => {
      // Skip the initial scan — components are already loaded
      if (isInitialScan) {
        isInitialScan = false;
        return;
      }
      console.log(`  ${yellow("File changed")} — reloading clients...`);
      try {
        await remoteServer.reload();
        console.log(`  ${pink("Hot reload complete")} (${remoteServer.getClientCount()} client(s))`);
      } catch (e: any) {
        console.error(`  Hot reload failed: ${e.message}`);
      }
    },
  });

  // Clean up on exit
  const cleanup = () => {
    console.log("\n  Stopping server...");
    watcher.stop();
    remoteServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`  ${pink("Server running.")} ${dim("Press Ctrl+C to stop.")}\n`);
}

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    port: { type: "string", short: "p" },
    debug: { type: "boolean", short: "d" },
    outDir: { type: "string", short: "o" },
    minify: { type: "boolean", short: "m" },
    sourcemap: { type: "boolean", short: "s" },
    open: { type: "boolean" },
    session: { type: "string" },
    url: { type: "string" },
    studio: { type: "boolean" },
    clean: { type: "boolean" },
  },
  allowPositionals: true,
});

// Handle global flags
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (values.version) {
  console.log(`${pink("hypen")} ${dim(`v${VERSION}`)}`);
  process.exit(0);
}

// Validate port if provided
if (values.port) {
  const port = parseInt(values.port);
  const portError = validatePort(port);
  if (portError) {
    console.error(`\n  Error: ${portError}\n`);
    process.exit(1);
  }
}

// Execute command
const command = positionals[0];

// First run on this machine? Walk new users through a short tour before
// handing off to the command. No-ops for non-interactive runs and after
// the first time (see src/onboarding.ts).
await maybeRunOnboarding(VERSION);

switch (command) {
  case "init":
    await initProject(positionals[1]);
    break;

  case "dev":
    await devServer({
      port: values.port ? parseInt(values.port) : undefined,
      debug: values.debug,
    });
    break;

  case "build":
    await buildProject({
      outDir: values.outDir,
      minify: values.minify,
      sourcemap: values.sourcemap,
    });
    break;

  case "generate":
    await generateComponents();
    break;

  case "studio":
    await startStudio({
      port: values.port ? parseInt(values.port) : undefined,
      open: values.open,
      session: values.session,
    });
    break;

  case "test":
    await testMode({
      port: values.port ? parseInt(values.port) : undefined,
      open: values.open,
    });
    break;

  case "run":
    await handleRun(positionals[1], {
      port: values.port ? parseInt(values.port) : undefined,
      url: values.url,
      studio: values.studio,
      clean: values.clean,
    });
    break;

  default:
    if (command) {
      console.error(`\n  Unknown command: ${command}\n`);
    }
    console.log(HELP);
    process.exit(command ? 1 : 0);
}
