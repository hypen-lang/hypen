/**
 * Kotlin project generator for `hypen init`.
 *
 * Emits a minimal Gradle project that uses `space.hypen:hypen-kotlin` to
 * define modules and Ktor's embedded Netty server to speak the Hypen
 * WebSocket protocol. Layouts mirror the TypeScript generator:
 *
 *   - `file-based`: modules are declared in Kotlin; UI templates live in
 *     `components/<Name>/<Name>.hypen` and are picked up via
 *     `watchComponents(...)`.
 *   - `server-based`: UI templates are kept as Kotlin string constants
 *     inside `Main.kt` and applied with `.ui(...)`.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { dim } from "../colors.js";
import type { ModuleLayout } from "./prompts.js";

interface Options {
  projectDir: string;
  projectName: string;
  layout: ModuleLayout;
}

function write(projectDir: string, relPath: string, content: string): void {
  writeFileSync(join(projectDir, relPath), content);
  console.log(`  ${dim("Created:")} ${relPath}`);
}

function ensureDir(projectDir: string, relPath: string): void {
  mkdirSync(join(projectDir, relPath), { recursive: true });
}

// ---------------------------------------------------------------------------
// DSL templates (shared between layouts)
// ---------------------------------------------------------------------------

const APP_HYPEN = `module App {
  Home()
}
.tw("flex-1 w-full min-h-screen bg-gray-50")
`;

const HOME_HYPEN = `module Home {
  Column {
    Column {
      Text("My Library")
        .tw("text-2xl md:text-3xl font-bold text-gray-900")

      Text("A starter list. Tap Save to bookmark an item.")
        .tw("text-sm md:text-base text-gray-500 mt-2")
    }
    .tw("bg-white rounded-2xl shadow-sm border border-gray-200 p-6 md:p-8")

    Column {
      ForEach(items: @state.items, key: "id") {
        Row {
          Column {
            Text("@{item.title}")
              .tw("font-semibold text-gray-900")
            Text("@{item.description}")
              .tw("text-sm text-gray-600 mt-1")
          }
          .tw("flex-1")

          If(condition: "@{item.bookmarked}") {
            Button {
              Text("Saved")
                .tw("text-green-700 font-semibold")
            }
            .tw("bg-green-50 border border-green-200 rounded-lg px-3 py-2 active:bg-green-100")
            .onClick(@actions.toggleBookmark, id: item.id)
          }

          If(condition: "@{!item.bookmarked}") {
            Button {
              Text("Save")
                .tw("text-blue-600 font-semibold")
            }
            .tw("bg-white border border-blue-200 rounded-lg px-3 py-2 active:bg-blue-50")
            .onClick(@actions.toggleBookmark, id: item.id)
          }
        }
        .tw("flex-row items-center gap-4 bg-white rounded-xl border border-gray-200 px-4 py-3")
      }
    }
    .tw("gap-3 mt-6")
  }
  .tw("flex-1 w-full max-w-2xl mx-auto p-4 md:p-8")
}
`;

// ---------------------------------------------------------------------------
// Kotlin / Gradle sources
// ---------------------------------------------------------------------------

const BUILD_GRADLE = `plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
}

group = "app.hypen.starter"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("space.hypen:hypen-kotlin:0.4.951")
    implementation("io.ktor:ktor-server-core:3.1.1")
    implementation("io.ktor:ktor-server-netty:3.1.1")
    implementation("io.ktor:ktor-server-websockets:3.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    // Without an SLF4J binding, every framework log (including connection
    // errors from hypen-kotlin) is silently swallowed by the NOP logger.
    runtimeOnly("org.slf4j:slf4j-simple:2.0.16")
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass.set("app.hypen.starter.MainKt")
}
`;

function settingsGradle(projectName: string): string {
  const safe = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `rootProject.name = "${safe}"
`;
}

const GITIGNORE = `# Gradle
.gradle/
build/

# IDE
.idea/
*.iml
.vscode/

# OS
.DS_Store

# Environment
.env
`;

function hypenConfig(layout: ModuleLayout): string {
  if (layout === "server-based") {
    return `{
  "layout": "server-based",
  "entry": "Main.kt",
  "port": 3000
}
`;
  }
  return `{
  "layout": "file-based",
  "components": "./components",
  "entry": "App",
  "port": 3000
}
`;
}

function mainKotlin(layout: ModuleLayout): string {
  const appUi = layout === "server-based" ? `        ui(appTemplate)\n` : ``;
  const homeUi = layout === "server-based" ? `        ui(homeTemplate)\n` : ``;

  const templateConsts = layout === "server-based"
    ? `
// Inline DSL templates — kept here so no \`.hypen\` files are needed.
private val appTemplate = """
${APP_HYPEN}""".trimStart()

private val homeTemplate = """
${HOME_HYPEN}""".trimStart()
`
    : ``;

  const watchCall = layout === "file-based"
    ? `        // Pick up Home() templates from disk and hot-reload when the
        // \`.hypen\` files change.
        watchComponents("./components")
`
    : ``;

  return `package app.hypen.starter

import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.Serializable
import space.hypen.core.*

// ---------- State types ----------

@Serializable
class AppState

@Serializable
data class Item(
    val id: String,
    val title: String,
    val description: String,
    var bookmarked: Boolean,
)

@Serializable
data class HomeState(
    var items: MutableList<Item> = mutableListOf(
        Item("1", "Declarative UI",  "Describe screens; Hypen handles the diffing.",       false),
        Item("2", "Reactive state",  "Mutate plain objects. Dependencies tracked for you.", false),
        Item("3", "Cross-platform",  "Same .hypen file renders on Web, iOS, and Android.",  false),
        Item("4", "Typed modules",   "State, actions, and UI in one typed unit.",            false),
    ),
)

// ---------- Typed actions (sealed for exhaustive handling) ----------

sealed interface HomeAction : HypenAction {
    @Serializable
    data class ToggleBookmark(val id: String) : HomeAction {
        override val _actionName: String get() = "toggleBookmark"
    }
}
${templateConsts}
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 3000

    val appModule = hypen(AppState()) {
        name("App")
${appUi}    }

    val homeModule = hypen(HomeState()) {
        name("Home")
        onAction<HomeAction.ToggleBookmark> { action, state, _ ->
            val item = state.items.find { it.id == action.id } ?: return@onAction
            item.bookmarked = !item.bookmarked
        }
${homeUi}    }

    val server = HypenServer {
        module("App", appModule)
        module("Home", homeModule)
        // The runtime needs at least one route to know which module is
        // the entry point. Without this, handleConnect cannot resolve a
        // root tree and the WS connection is torn down after upgrade.
        route("/", "App")
${watchCall}    }

    // Ktor embedded WebSocket server — clients speak the Hypen remote
    // protocol over a single "/" endpoint.
    val engine = embeddedServer(Netty, port = port) {
        install(WebSockets) {
            pingPeriod = 15.seconds
            timeout = 15.seconds
            maxFrameSize = Long.MAX_VALUE
            masking = false
        }
        routing {
            // The Hypen wire protocol is served at /ws — every Hypen client
            // (Studio's RemoteEngine, the Swift runner, the Go/TS SDKs) opens
            // ws://host:port/ws. Putting the handler at "/" silently breaks
            // those clients with an upgrade-then-reset.
            webSocket("/ws") {
                val sendMessage: suspend (String) -> Unit = { msg ->
                    // Swallow send errors — the \`for (frame in incoming)\` loop
                    // below will exit and trigger handleDisconnect in finally.
                    try { send(Frame.Text(msg)) } catch (_: Exception) {}
                }

                try {
                    val initialTree = server.handleConnect(
                        connectionKey = this,
                        sendMessage = sendMessage
                    )
                    sendMessage(initialTree)

                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            server.handleMessage(
                                connectionKey = this,
                                message = frame.readText(),
                                sendMessage = sendMessage
                            )
                        }
                    }
                } catch (e: Exception) {
                    // Surface handler errors to stdout — hypen-kotlin uses
                    // SLF4J for its own logs; without a binding the NOP
                    // sink swallows them and the WS just silently 1006s.
                    System.err.println("[ws] handler error: \${e.message}")
                    e.printStackTrace()
                } finally {
                    server.handleDisconnect(this)
                }
            }
        }
    }
    println("Hypen Kotlin server running on ws://localhost:$port/ws")
    engine.start(wait = false)
    // Keep the JVM alive; Ctrl-C still terminates.
    Thread.currentThread().join()
}
`;
}

function readme(projectName: string, layout: ModuleLayout): string {
  const layoutNote =
    layout === "file-based"
      ? "UI templates live in `components/<Name>/<Name>.hypen` and hot-reload via `watchComponents`."
      : "UI templates are inline string constants in `src/main/kotlin/app/hypen/starter/Main.kt`.";

  return `# ${projectName}

Hypen project scaffolded with \`hypen init\` (Kotlin, ${layout}).

## Requirements

- JDK 17+
- Gradle (or use the generated \`./gradlew\` wrapper)
- The native Hypen engine library — see \`hypen-kotlin/README.md\` for
  platform-specific build instructions, then add
  \`-Djna.library.path=<path-to-libhypen>\` to the run command.

## Getting started

\`\`\`bash
./gradlew run
\`\`\`

${layoutNote}
`;
}

/**
 * Entrypoint used by `bin/hypen.ts`.
 */
export function generateKotlinProject(opts: Options): void {
  const { projectDir, projectName, layout } = opts;

  for (const rel of [
    "src",
    "src/main",
    "src/main/kotlin",
    "src/main/kotlin/app",
    "src/main/kotlin/app/hypen",
    "src/main/kotlin/app/hypen/starter",
  ]) {
    ensureDir(projectDir, rel);
  }

  write(projectDir, "build.gradle.kts", BUILD_GRADLE);
  write(projectDir, "settings.gradle.kts", settingsGradle(projectName));
  write(projectDir, ".gitignore", GITIGNORE);
  write(projectDir, "hypen.json", hypenConfig(layout));
  write(projectDir, "README.md", readme(projectName, layout));
  write(projectDir, "src/main/kotlin/app/hypen/starter/Main.kt", mainKotlin(layout));

  if (layout === "file-based") {
    for (const rel of [
      "components",
      "components/App",
      "components/Home",
    ]) {
      ensureDir(projectDir, rel);
    }
    write(projectDir, "components/App/App.hypen", APP_HYPEN);
    write(projectDir, "components/Home/Home.hypen", HOME_HYPEN);
  }
}
