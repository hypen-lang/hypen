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
  Router {
    Route(path: "/") {
      Home()
    }
    Route(path: "/counter") {
      Counter()
    }
  }
  .tw("flex-1 w-full h-full")
}
.tw("flex-1 w-full h-full bg-white")
`;

const HOME_HYPEN = `module Home {
  Column {
    Text("@{state.greeting}")
      .tw("text-3xl font-bold text-gray-900")
      .fontSize(32)

    Text("You have tapped @{state.taps} time(s).")
      .tw("text-base text-gray-600 mt-2")
      .fontSize(16)

    Row {
      Button {
        Text("Tap me")
          .tw("text-white font-semibold")
      }
      .tw("bg-blue-600 rounded-lg px-4 py-2")
      .padding(12)
      .backgroundColor("#2563eb")
      .borderRadius(8)
      .onClick(@actions.tap)

      Button {
        Text("Go to Counter →")
          .tw("text-blue-600 font-semibold")
      }
      .tw("bg-white border border-blue-600 rounded-lg px-4 py-2")
      .padding(12)
      .borderRadius(8)
      .onClick(@actions.navigate, to: "/counter")
    }
    .tw("flex-row gap-3 mt-6")
    .gap(12)
  }
  .tw("flex-1 items-center justify-center p-8 bg-gray-50")
  .padding(32)
  .gap(8)
}
`;

const COUNTER_HYPEN = `module Counter {
  Column {
    Text("Hypen Counter")
      .tw("text-2xl font-bold text-gray-900")
      .fontSize(24)

    Text("@{state.count}")
      .tw("text-6xl font-bold text-blue-600 my-8")
      .fontSize(64)
      .color("#2563eb")
      .marginVertical(32)

    Row {
      Button {
        Text("-")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-red-600 rounded-lg px-6 py-3")
      .padding(16)
      .backgroundColor("#dc2626")
      .borderRadius(8)
      .onClick(@actions.decrement)

      Button {
        Text("Reset")
          .tw("text-white font-semibold")
      }
      .tw("bg-gray-600 rounded-lg px-6 py-3")
      .padding(16)
      .backgroundColor("#4b5563")
      .borderRadius(8)
      .onClick(@actions.reset)

      Button {
        Text("+")
          .tw("text-white text-xl font-bold")
      }
      .tw("bg-green-600 rounded-lg px-6 py-3")
      .padding(16)
      .backgroundColor("#16a34a")
      .borderRadius(8)
      .onClick(@actions.increment)
    }
    .tw("flex-row gap-4")
    .gap(16)

    Button {
      Text("← Back to Home")
        .tw("text-blue-600 font-semibold")
    }
    .tw("mt-8 bg-transparent")
    .padding(12)
    .onClick(@actions.navigate, to: "/")
  }
  .tw("flex-1 items-center justify-center p-8 bg-white")
  .padding(32)
  .gap(12)
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
    // Resolve the latest published SDK from Maven Central, mirroring the
    // TypeScript scaffold's use of "latest" for @hypen-space/* (avoids a
    // hardcoded version number that goes stale between releases).
    implementation("space.hypen:hypen-kotlin:latest.release")
    implementation("io.ktor:ktor-server-core:3.1.1")
    implementation("io.ktor:ktor-server-netty:3.1.1")
    implementation("io.ktor:ktor-server-websockets:3.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
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

function hypenConfig(): string {
  return `{
  "components": "./components",
  "entry": "App",
  "port": 3000
}
`;
}

function mainKotlin(layout: ModuleLayout): string {
  const uiCalls = layout === "server-based"
    ? `        ui(appTemplate)\n`
    : ``;
  const homeUi = layout === "server-based" ? `        ui(homeTemplate)\n` : ``;
  const counterUi = layout === "server-based" ? `        ui(counterTemplate)\n` : ``;

  const templateConsts = layout === "server-based"
    ? `
// Inline DSL templates — kept here so no \`.hypen\` files are needed.
private val appTemplate = """
${APP_HYPEN}""".trimStart()

private val homeTemplate = """
${HOME_HYPEN}""".trimStart()

private val counterTemplate = """
${COUNTER_HYPEN}""".trimStart()
`
    : ``;

  const watchCall = layout === "file-based"
    ? `        // Pick up Home() and Counter() templates from disk and hot-reload
        // when their \`.hypen\` files change.
        watchComponents("./components")
`
    : ``;

  const routes = `        route("/", "App")
        route("/counter", "Counter")
`;

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
data class AppState(
    var location: String = "/",
    var previousLocation: String = "/",
)

@Serializable
data class HomeState(
    var greeting: String = "Welcome to Hypen",
    var taps: Int = 0,
)

@Serializable
data class CounterState(var count: Int = 0)

// ---------- Typed actions (sealed for exhaustive handling) ----------

sealed interface AppAction : HypenAction {
    @Serializable
    data class Navigate(val to: String) : AppAction {
        override val _actionName: String get() = "navigate"
    }
    data object NavigateBack : AppAction {
        override val _actionName: String get() = "navigateBack"
    }
}

sealed interface HomeAction : HypenAction {
    data object Tap : HomeAction {
        override val _actionName: String get() = "tap"
    }
    @Serializable
    data class UpdateGreeting(val greeting: String) : HomeAction {
        override val _actionName: String get() = "updateGreeting"
    }
}

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction {
        override val _actionName: String get() = "increment"
    }
    data object Decrement : CounterAction {
        override val _actionName: String get() = "decrement"
    }
    data object Reset : CounterAction {
        override val _actionName: String get() = "reset"
    }
    @Serializable
    data class Step(val by: Int) : CounterAction {
        override val _actionName: String get() = "step"
    }
}
${templateConsts}
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 3000

    val appModule = hypen(AppState()) {
        name("App")
        onAction<AppAction.Navigate> { action, state, _ ->
            if (action.to.isNotEmpty() && action.to != state.location) {
                state.previousLocation = state.location
                state.location = action.to
            }
        }
        onAction<AppAction.NavigateBack> { _, state, _ ->
            val back = state.previousLocation.ifEmpty { "/" }
            state.previousLocation = state.location
            state.location = back
        }
${uiCalls}    }

    val homeModule = hypen(HomeState()) {
        name("Home")
        onAction<HomeAction.Tap> { _, state, _ ->
            state.taps += 1
        }
        onAction<HomeAction.UpdateGreeting> { action, state, _ ->
            if (action.greeting.isNotEmpty()) state.greeting = action.greeting
        }
${homeUi}    }

    val counterModule = hypen(CounterState()) {
        name("Counter")
        onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
        onAction<CounterAction.Decrement> { _, state, _ -> state.count -= 1 }
        onAction<CounterAction.Reset>     { _, state, _ -> state.count  = 0 }
        onAction<CounterAction.Step>      { action, state, _ -> state.count += action.by }
${counterUi}    }

    val server = HypenServer {
        module("App", appModule)
        module("Home", homeModule)
        module("Counter", counterModule)
${routes}${watchCall}    }

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
            webSocket("/") {
                val sendMessage: suspend (String) -> Unit = { msg ->
                    // Swallow send errors — the \`for (frame in incoming)\` loop
                    // below will exit and trigger handleDisconnect in finally.
                    try { send(Frame.Text(msg)) } catch (_: Exception) {}
                }

                val initialTree = server.handleConnect(
                    connectionKey = this,
                    sendMessage = sendMessage
                )
                sendMessage(initialTree)

                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            server.handleMessage(
                                connectionKey = this,
                                message = frame.readText(),
                                sendMessage = sendMessage
                            )
                        }
                    }
                } finally {
                    server.handleDisconnect(this)
                }
            }
        }
    }
    println("Hypen Kotlin server running on ws://localhost:$port")
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
  write(projectDir, "hypen.json", hypenConfig());
  write(projectDir, "README.md", readme(projectName, layout));
  write(projectDir, "src/main/kotlin/app/hypen/starter/Main.kt", mainKotlin(layout));

  if (layout === "file-based") {
    for (const rel of [
      "components",
      "components/App",
      "components/Home",
      "components/Counter",
    ]) {
      ensureDir(projectDir, rel);
    }
    write(projectDir, "components/App/App.hypen", APP_HYPEN);
    write(projectDir, "components/Home/Home.hypen", HOME_HYPEN);
    write(projectDir, "components/Counter/Counter.hypen", COUNTER_HYPEN);
  }
}
