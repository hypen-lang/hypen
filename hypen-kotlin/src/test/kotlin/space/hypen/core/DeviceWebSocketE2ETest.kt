package space.hypen.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import space.hypen.remote.device.BluetoothScanParams
import space.hypen.remote.device.Capability
import space.hypen.remote.device.DeviceResult
import space.hypen.remote.device.GalleryPickParams
import space.hypen.remote.device.MediaType
import space.hypen.remote.device.MicFormat
import space.hypen.remote.device.MicRecordParams
import space.hypen.remote.device.Permission
import space.hypen.remote.device.VerifiedBlob
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Cross-language end-to-end test of the Kotlin device plane: the TypeScript
 * web client (hypen-web `RemoteEngine` + `FakeDeviceHost` / `DeviceClient`,
 * run with bun) connects over a real WebSocket (Netty) to [HypenServer],
 * whose device plane runs on the Rust broker (UniFFI via JNA).
 *
 *     cd hypen-kotlin && ./gradlew deviceE2eTest --offline
 *
 * Needs `bun` on PATH and hypen-web's node_modules (`cd hypen-web && bun
 * install`); this dedicated task fails when they are missing (the default
 * `test` task excludes the `e2e` tag).
 */
@Tag("e2e")
class DeviceWebSocketE2ETest {
    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    private class Recorder {
        val values = ConcurrentHashMap<String, Any>()
        val waiters = ConcurrentHashMap<String, CompletableDeferred<Any>>()
        val activations = mutableListOf<String>()

        fun put(key: String, value: Any) {
            values[key] = value
            waiters.computeIfAbsent(key) { CompletableDeferred() }.complete(value)
        }
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun e2ePhoto() = ByteArray(100_000) { ((it * 31 + 7) and 0xff).toByte() }

    private fun e2eSave() = "hypen-e2e-save ".repeat(10_000).toByteArray()

    private val keys = listOf("supports", "query", "queryMic", "queryResumed", "pick", "save", "scan", "record", "slowPick", "slowRequest")

    private fun e2eApp(rec: Recorder): ModuleDefinition<MutableMap<String, Any?>> {
        val slowJob = java.util.concurrent.atomic.AtomicReference<Job?>(null)
        // The DEFAULT server path: the primary's `Router` block is
        // auto-wired into a per-session ManagedRouter, which activates the
        // route module (`Page`) while the session is being established.
        val ui = "module App {\n  Column {\n" + keys.joinToString("\n") { "    Text(\"$it:@{state.$it}\")" } +
            "\n    Router { Route(path: \"/\") { Page() } }\n  }\n}"
        fun <T> DeviceResult<T>.text(ok: (T) -> String): String = when (this) {
            is DeviceResult.Ok -> ok(value)
            is DeviceResult.Err -> error.code.wireName
        }
        return AppBuilder(keys.associateWith<String, Any?> { "" }.toMutableMap())
            .ui(ui)
            .onActionAsync("e2eSupports") { ctx ->
                val d = ctx.device
                ctx.state.set("supports", "${d.supports(Capability.GALLERY_PICK)},${d.supports(Capability.MIC_RECORD)},${d.supports(Capability.CAMERA_CAPTURE)}")
            }
            .onActionAsync("e2eQuery") { ctx ->
                val p = ctx.action.payload as? JsonObject
                val perm = Permission.fromWireName((p?.get("permission") as? JsonPrimitive)?.content ?: "") ?: Permission.CAMERA
                val out = ctx.device.permissions.query(perm).text { it.wireName }
                val key = (p?.get("key") as? JsonPrimitive)?.content ?: "query"
                ctx.state.set(key, out)
                rec.put(key, out)
            }
            .onActionAsync("e2eQueryMic") { ctx ->
                ctx.state.set("queryMic", ctx.device.permissions.query(Permission.MICROPHONE).text { it.wireName })
            }
            .onActionAsync("e2ePick") { ctx ->
                val r = ctx.device.gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1))
                r.getOrNull()?.let { rec.put("pick", it.single()) }
                ctx.state.set("pick", r.text { items -> items.single().let { "${it.bytes.size}|${it.sha256}|${it.contentType}" } })
            }
            .onActionAsync("e2eSave") { ctx ->
                ctx.state.set("save", ctx.device.files.save(e2eSave(), "e2e.txt", "text/plain").text { "${it.bytesWritten}" })
            }
            .onActionAsync("e2eScan") { ctx ->
                // A cold Flow: collecting opens the scan, take(2) cancels it.
                val ids = try {
                    ctx.device.events(Capability.BLUETOOTH_SCAN, BluetoothScanParams).take(2).toList().joinToString(",") { it.device.id }
                } catch (e: space.hypen.remote.device.DeviceException) {
                    e.failure.code.wireName
                }
                ctx.state.set("scan", ids)
            }
            .onActionAsync("e2eRecord") { ctx ->
                val pcm = java.io.ByteArrayOutputStream()
                val stream = ctx.device.mic.record(MicRecordParams(8000, MicFormat.PCM16)) { pcm.write(it) }
                val out = stream.await().text { res ->
                    val bytes = pcm.toByteArray()
                    if (res.item.sha256 != sha(bytes) || res.item.bytes != bytes.size.toLong()) {
                        "delivered bytes do not match the verified result"
                    } else {
                        "${bytes.size}|${res.item.sha256}|${res.durationMs}"
                    }
                }
                ctx.state.set("record", out)
            }
            .onActionAsync("e2eSlowPick") { ctx ->
                // Cancellation is coroutine cancellation: e2eCancelPick cancels
                // this child job while the pick is pending on the client.
                var outcome = "unexpected success"
                coroutineScope {
                    val job = launch {
                        try {
                            val r = ctx.device.gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1))
                            outcome = r.text { "unexpected success" }
                        } catch (e: CancellationException) {
                            outcome = "cancelled"
                            throw e
                        }
                    }
                    slowJob.set(job)
                    job.join()
                }
                rec.put("slowPick", outcome)
                ctx.state.set("slowPick", outcome)
            }
            .onActionAsync("e2eCancelPick") { _ -> slowJob.get()?.cancel() }
            .onActionAsync("e2eSlowRequest") { ctx ->
                ctx.state.set("slowRequest", ctx.device.permissions.request(Permission.NOTIFICATIONS).text { it.wireName })
            }
            .build()
            .copy(name = "App")
    }

    /**
     * The auto-wired route module: its `onActivated` issues device work at
     * once. The device plane attaches (and `core.capabilities` opens) before
     * any module activation, so this context is live.
     */
    private fun registerPage(rec: Recorder, scope: CoroutineScope) {
        app.module("Page")
            .defineState(mapOf<String, Any?>())
            .onActivated { _, ctx ->
                val device = ctx?.device
                scope.launch {
                    val r = device?.permissions?.query(Permission.CAMERA)
                    val out = when (r) {
                        is DeviceResult.Ok -> r.value.wireName
                        is DeviceResult.Err -> "${r.error.code.wireName}:${r.error.platformDetail}"
                        null -> "no context"
                    }
                    synchronized(rec.activations) { rec.activations += out }
                }
            }
            .build()
    }

    @Test
    fun `the TypeScript web client drives the Kotlin device plane over a real WebSocket`() {
        val bun = listOf(System.getenv("BUN_PATH"), "${System.getProperty("user.home")}/.bun/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun")
            .firstOrNull { it != null && File(it).canExecute() }
            ?: System.getenv("PATH").orEmpty().split(File.pathSeparator).map { File(it, "bun") }.firstOrNull { it.canExecute() }?.path
            ?: fail("cross-language e2e needs bun on PATH")
        val root = File(".").canonicalFile
        val web = File(root, "../hypen-web").canonicalFile
        if (!File(web, "node_modules/@hypen-space/core").exists()) {
            fail("cross-language e2e needs hypen-web/node_modules (cd hypen-web && bun install)")
        }
        val script = File(root, "src/test/e2e/device_e2e_client.ts")

        val rec = Recorder()
        val pageScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        registerPage(rec, pageScope)
        val appDef = e2eApp(rec)
        // No disableAutoRouter(): the default auto-wired router path.
        val server = HypenServer {
            module("App", appDef)
            route("/", "App")
            allowedOrigins("http://app.e2e")
            authenticate { it.header("Authorization") == "Bearer e2e" }
            // No device call: the device plane is on by default.
        }
        NettyHypenWebSocketServer(server).use { ws ->
            val proc = ProcessBuilder(bun, "run", script.path, ws.url)
                .directory(root)
                .redirectError(ProcessBuilder.Redirect.PIPE)
                .apply { environment()["NODE_ENV"] = "test" }
                .start()
            val stderr = StringBuilder()
            val errReader = Thread { proc.errorStream.bufferedReader().forEachLine { synchronized(stderr) { stderr.appendLine(it) } } }
            errReader.start()
            val checks = linkedMapOf<String, Boolean>()
            var done = false
            proc.inputStream.bufferedReader().forEachLine { line ->
                val m = runCatching { Json.parseToJsonElement(line).jsonObject }.getOrNull() ?: return@forEachLine
                m["check"]?.jsonPrimitive?.content?.let { name ->
                    val ok = m["ok"]?.jsonPrimitive?.content == "true"
                    checks[name] = ok
                    println((if (ok) "ts ok   " else "ts FAIL ") + name + if (ok) "" else " $line")
                }
                if (m["event"]?.jsonPrimitive?.content == "done") done = true
            }
            val exited = proc.waitFor(3, TimeUnit.MINUTES)
            errReader.join(2_000)
            if (!exited) proc.destroyForcibly()
            val exit = if (exited) proc.exitValue() else -1
            val failedChecks = checks.filterValues { !it }.keys
            assertTrue(done && exit == 0 && failedChecks.isEmpty(), "TypeScript client failed (exit $exit, failed: $failedChecks)\nstderr:\n${synchronized(stderr) { stderr.takeLast(4000) }}")

            for (name in listOf(
                "origin-403", "no-credentials-403", "allowed-origin-admitted", "authenticator-admits",
                "handshake-device-ack", "core-capabilities-opened", "route-module-activation-device", "resume-token-issued", "supports",
                "permission-query", "permission-query-denied-status", "gallery-pick-hash-verified",
                "file-save-download", "bluetooth-scan-events", "bluetooth-scan-cancelled-on-client",
                "mic-record-data", "cancel-handler-result", "cancel-reached-client", "slow-request-result",
                "lease-renewals", "resume-wrong-token-new-session", "resume-with-token", "resumed-plane-works",
            )) {
                assertEquals(true, checks[name], "check $name missing or failed")
            }

            // What the Kotlin handlers saw.
            val blob = rec.values["pick"] as VerifiedBlob
            assertContentEquals(e2ePhoto(), blob.bytes)
            assertEquals(sha(e2ePhoto()), blob.sha256)
            assertEquals("cancelled", rec.values["slowPick"])
            assertEquals("granted", rec.values["queryResumed"])
            // The route module's onActivated had a live device context on
            // every session: granted on the long-lived connection and the
            // resumed one; sessions the script disposes at once (admission
            // probe, wrong-token session) lose the connection mid-request —
            // never a dead `unavailable` context.
            val activations = synchronized(rec.activations) { rec.activations.toList() }
            assertTrue(activations.size >= 4, "route module activations: $activations")
            assertTrue(activations.count { it == "granted" } >= 2, "route module activations: $activations")
            assertTrue(activations.all { it == "granted" || it.startsWith("connectionLost") }, "route module activations: $activations")
            // Admission verdicts: two refusals (foreign Origin, no credentials) then admits.
            val verdicts = ws.admissions.toList()
            assertEquals(2, verdicts.count { it is Admission.Rejected }, "$verdicts")
            assertTrue(verdicts.take(2).all { it is Admission.Rejected && it.status == 403 })
        }
        server.shutdown()
        pageScope.cancel()
    }
}
