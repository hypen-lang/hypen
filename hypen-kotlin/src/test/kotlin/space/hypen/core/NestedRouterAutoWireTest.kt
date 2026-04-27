package space.hypen.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Kotlin parity port of the TS `nested-router-auto-wire.test.ts` test.
 *
 * When a per-route module's template itself contains a `Router { Route ... }`
 * block, the SDK's auto-wire flattens every discovered router's routes —
 * primary and nested — into a single [ManagedRouter] against the
 * session's one [HypenRouter]. This guards the commit-77fadf05 change
 * in [HypenServer.autoWireRouterForClient] that dropped the top-level
 * filter so nested-router routes also land in the session's router.
 */
class NestedRouterAutoWireTest {

    private var tmpDir: Path? = null

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    @AfterEach
    fun cleanup() {
        tmpDir?.toFile()?.deleteRecursively()
        tmpDir = null
        HypenApp.clear()
    }

    /**
     * Materialize a component tree on disk so the test harness looks
     * like its TS twin. The dir isn't required for auto-wire itself
     * (the Kotlin `discoverRouters` call only sees the primary .ui
     * string), but keeping the tmpfs step makes the parity with the
     * TS test explicit and exercises the cleanup path.
     */
    private fun writeComponents(entries: Map<String, String>): Path {
        val dir = Files.createTempDirectory("hypen-nested-router-")
        for ((name, dsl) in entries) {
            val sub = dir.resolve(name)
            Files.createDirectories(sub)
            sub.resolve("component.hypen").writeText(dsl)
        }
        return dir
    }

    @Test
    fun `routes declared in a nested module's Router block can be navigated to`() = runBlocking {
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        // Tmpfs component tree — matches the TS test shape. Cleaned up in @AfterEach.
        tmpDir = writeComponents(
            mapOf(
                "App" to """module App {
                    Router {
                        Route(path: "/") { Home() }
                        Route(path: "/settings") { Settings() }
                    }
                }""".trimIndent(),
                "Home" to """module Home {
                    Column {
                        Text("home-root")
                        Router {
                            Route(path: "/home/feed") { Feed() }
                            Route(path: "/home/explore") { Explore() }
                        }
                    }
                }""".trimIndent(),
                "Feed" to """module Feed { Text("feed-body") }""".trimIndent(),
                "Explore" to """module Explore { Text("explore-body") }""".trimIndent(),
                "Settings" to """module Settings { Text("settings-body") }""".trimIndent(),
            )
        )

        // The primary module's `.ui` must itself contain every module
        // definition (App + Home + Feed + ...) so the engine's
        // `discoverRouters` — which parses the source as a single
        // multi-component document — sees the nested Router inside the
        // `module Home { ... }` block. Without the post-77fadf05 filter
        // lift, that nested router's /home/feed route would be ignored.
        val multiModuleSource = """
            module App {
                Router {
                    Route(path: "/") { Home() }
                    Route(path: "/settings") { Settings() }
                }
            }
            module Home {
                Column {
                    Text("home-root")
                    Router {
                        Route(path: "/home/feed") { Feed() }
                        Route(path: "/home/explore") { Explore() }
                    }
                }
            }
            module Feed { Text("feed-body") }
            module Explore { Text("explore-body") }
            module Settings { Text("settings-body") }
        """.trimIndent()

        // The real 3.4 signal: did `ManagedRouter` *mount* the Feed
        // module on nav? `HypenRouter.onNavigate` fires on every
        // `router.push` regardless of whether any route is registered,
        // so it's a weak probe. Module lifecycle firing is a strong
        // probe — it only happens when `managed.addRoute("/home/feed",
        // "Feed")` was called (the 77fadf05 change), which then triggers
        // `instance.activate()` on the mount path.
        val feedActivations = mutableListOf<String>()

        app.module("App").defineState(
            mapOf("location" to "/")
        ).ui(multiModuleSource).build()

        // Home/Explore/Settings are placeholders — they just need to
        // exist in HypenApp so auto-wire's element-name match can find
        // them. Feed gets an onActivated probe.
        app.module("Home").defineState(mapOf<String, Any?>()).build()
        app.module("Feed")
            .defineState(mapOf<String, Any?>())
            .onActivated { _, ctx ->
                val path = ctx?.getRouter()?.getCurrentPath() ?: "(no router)"
                synchronized(feedActivations) { feedActivations.add(path) }
            }
            .build()
        app.module("Explore").defineState(mapOf<String, Any?>()).build()
        app.module("Settings").defineState(mapOf<String, Any?>()).build()

        val server = HypenServer {
            module("App", HypenApp.get("App")!!)
            route("/", "App")
        }

        try {
            val sent = mutableListOf<String>()
            val connectionKey = Any()
            val sendMessage: suspend (String) -> Unit = { msg ->
                synchronized(sent) { sent.add(msg) }
            }

            server.handleConnect(
                connectionKey = connectionKey,
                sendMessage = sendMessage
            )

            // Dispatch the nested-route push through the same message
            // path a remote client would use. Pre-3.4 this would be a
            // no-op because auto-wire skipped nested-router routes.
            val pushMsg = """{"type":"dispatchAction","action":"router.push","payload":{"to":"/home/feed"}}"""
            server.handleMessage(connectionKey, pushMsg, sendMessage)

            val observed = synchronized(feedActivations) { feedActivations.toList() }
            assertTrue(
                observed.isNotEmpty(),
                "Feed.onActivated should have fired when nav landed on /home/feed. " +
                    "Empty list here means `managed.addRoute(\"/home/feed\", \"Feed\")` " +
                    "was never called — i.e. auto-wire's nested-router filter is " +
                    "back (reverting 77fadf05)."
            )
            assertEquals("/home/feed", observed.last())

            server.handleDisconnect(connectionKey)
        } finally {
            server.shutdown()
        }
    }

    /**
     * P1-A regression (Kotlin port of commit 9adcb3f2 TS fix).
     *
     * The primary module's `.ui` contains ONLY the top-level routes —
     * the nested Router lives exclusively on Home's own `.ui(...)`
     * sidecar string. Pre-fix, `autoWireRouterForClient` called
     * `discoverRouters` only on `primaryDef.ui` and never iterated
     * children, so the `/home/feed` route was invisible to
     * ManagedRouter. Post-fix, discover is run over every registered
     * module's `.ui` and routes are deduped by path (first-seen wins).
     *
     * Feed's `onActivated` is the probe: it fires only when
     * ManagedRouter actually mounted the Feed module for the route —
     * i.e. when `managed.addRoute(path="/home/feed", component="Feed")`
     * was called during auto-wire. Using `HypenRouter.onNavigate`
     * would be a weak probe since it fires on every router.push
     * regardless of whether the route was registered.
     */
    @Test
    fun `routes declared only in a child module's UI are discovered and mounted`() = runBlocking {
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        val feedActivations = mutableListOf<String>()

        // Primary App's `.ui` contains ONLY the top-level route to
        // Home — no mention of "/home/feed" anywhere in this string.
        app.module("App")
            .defineState(mapOf("location" to "/"))
            .ui(
                """module App {
                    Router {
                        Route(path: "/") { Home() }
                    }
                }""".trimIndent()
            )
            .build()

        // Home is registered with its OWN `.ui(...)` sidecar string
        // carrying the nested Router. This is the canonical
        // child-component shape — pre-fix, this template was never
        // inspected by auto-wire.
        app.module("Home")
            .defineState(mapOf<String, Any?>())
            .ui(
                """module Home {
                    Column {
                        Text("home-root")
                        Router {
                            Route(path: "/home/feed") { Feed() }
                        }
                    }
                }""".trimIndent()
            )
            .build()

        app.module("Feed")
            .defineState(mapOf<String, Any?>())
            .onActivated { _, ctx ->
                val path = ctx?.getRouter()?.getCurrentPath() ?: "(no router)"
                synchronized(feedActivations) { feedActivations.add(path) }
            }
            .build()

        val server = HypenServer {
            module("App", HypenApp.get("App")!!)
            route("/", "App")
        }

        try {
            val sent = mutableListOf<String>()
            val connectionKey = Any()
            val sendMessage: suspend (String) -> Unit = { msg ->
                synchronized(sent) { sent.add(msg) }
            }

            server.handleConnect(
                connectionKey = connectionKey,
                sendMessage = sendMessage
            )

            val pushMsg =
                """{"type":"dispatchAction","action":"router.push","payload":{"to":"/home/feed"}}"""
            server.handleMessage(connectionKey, pushMsg, sendMessage)

            val observed = synchronized(feedActivations) { feedActivations.toList() }
            assertTrue(
                observed.isNotEmpty(),
                "Feed.onActivated should have fired when nav landed on /home/feed. " +
                    "Empty list here means auto-wire never iterated Home's `.ui` to " +
                    "discover its nested Router — i.e. the P1-A fix (9adcb3f2) regressed."
            )
            assertEquals("/home/feed", observed.last())

            server.handleDisconnect(connectionKey)
        } finally {
            server.shutdown()
        }
    }
}
