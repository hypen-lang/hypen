package space.hypen.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import space.hypen.remote.device.BluetoothScanParams
import space.hypen.remote.device.Capability
import space.hypen.remote.device.DeviceContext
import space.hypen.remote.device.DeviceErrorCode
import space.hypen.remote.device.DevicePlaneTest
import space.hypen.remote.device.DeviceRequestOptions
import space.hypen.remote.device.DeviceResult
import space.hypen.remote.device.Lifetime
import space.hypen.remote.device.Permission
import space.hypen.remote.device.PermissionStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Activation authority tied to the Kotlin module lifecycle (RFC 001 §2.7):
 * `activate()` registers a fresh activation with the connection's broker
 * before `onActivated`, `deactivate()` sweeps that activation's work before
 * `onDeactivated`, `destroy()` sweeps everything (background work too); the
 * handler contexts capture owner + provenance at dispatch time (replay
 * firewall), and a suspend action handler is a device handler scope.
 * Runs over the real Rust broker with a scripted client.
 */
class DeviceModuleLifecycleTest {
    private fun TestScope.plane(extra: String = "") = DevicePlaneTest.Harness(this, extra)

    private fun gc(h: DevicePlaneTest.Harness) = HypenGlobalContext().also { it.devicePlane = h.plane }

    private fun definition(
        onActivated: LifecycleHandler<MutableMap<String, Any?>>? = null,
        onCreated: LifecycleHandler<MutableMap<String, Any?>>? = null,
        async: Map<String, SuspendModuleActionHandler<MutableMap<String, Any?>>> = emptyMap(),
        sync: Map<String, ModuleActionHandler<MutableMap<String, Any?>>> = emptyMap(),
    ): ModuleDefinition<MutableMap<String, Any?>> {
        var b = AppBuilder(mutableMapOf<String, Any?>("r" to ""))
        onActivated?.let { b = b.onActivated(it) }
        onCreated?.let { b = b.onCreated(it) }
        async.forEach { (n, h) -> b = b.onActionAsync(n, h) }
        sync.forEach { (n, h) -> b = b.onAction(n, h) }
        return b.build().copy(name = "M")
    }

    @Test
    fun `activation registers authority before onActivated and deactivation sweeps it`() = runTest {
        val h = plane()
        h.client.driver("permission.query") { respond(buildJsonObject { put("status", "prompt") }) }
        h.client.driver("gallery.pick") { cancelled.await() }
        var createdDevice: DeviceContext? = null
        var activatedDevice: DeviceContext? = null
        val def = definition(
            onCreated = { _, ctx -> createdDevice = ctx?.device },
            onActivated = { _, ctx -> activatedDevice = ctx?.device },
        )
        val m = ModuleInstance(MockEngine(), def, globalContext = gc(h), scope = backgroundScope)
        // onCreated runs before any activation: no authority.
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "owner-inactive"), createdDevice!!.permissions.query(Permission.CAMERA))

        m.activate()
        assertTrue(h.plane.ownerIsActive(m.deviceInstanceId, 1u))
        val device = assertNotNull(activatedDevice)
        assertEquals(DeviceResult.Ok(PermissionStatus.PROMPT, simulated = true), device.permissions.query(Permission.CAMERA))

        val pick = async { device.gallery.pick(space.hypen.remote.device.GalleryPickParams(listOf(space.hypen.remote.device.MediaType.PHOTO), 1)) }
        runCurrent()
        m.deactivate()
        assertEquals(DeviceResult.Err(DeviceErrorCode.CANCELLED), pick.await())
        runCurrent()
        val id = h.client.requests("gallery.pick").single()["id"]!!.jsonPrimitive.long
        assertTrue(h.client.controls(id, "cancel").isNotEmpty(), "the sweep told the client")

        // The captured activation stays dead after re-activation.
        m.activate()
        assertTrue(h.plane.ownerIsActive(m.deviceInstanceId, 2u))
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "owner-inactive"), device.permissions.query(Permission.CAMERA))
        assertNotEquals(device, activatedDevice)
        assertTrue(activatedDevice!!.permissions.query(Permission.CAMERA).isOk)
        m.destroy()
        assertFalse(h.plane.ownerIsActive(m.deviceInstanceId, 2u))
        h.plane.close()
    }

    @Test
    fun `background work survives deactivation, pins the module, and is swept on destroy`() = runTest {
        val h = plane(""","revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}],"maxBackgroundOwners":1""")
        h.client.driver("bluetooth.scan") { cancelled.await(); respond(buildJsonObject { }) }
        var device: DeviceContext? = null
        val a = ModuleInstance(MockEngine(), definition(onActivated = { _, ctx -> device = ctx?.device }), globalContext = gc(h), scope = backgroundScope)
        a.activate()
        val stream = device!!.stream(Capability.BLUETOOTH_SCAN, BluetoothScanParams, DeviceRequestOptions(lifetime = Lifetime.BACKGROUND)) { }
        assertNotNull(stream.id)
        assertEquals("background", h.client.requests("bluetooth.scan").let { runCurrent(); h.client.requests("bluetooth.scan") }.single()["lifetime"]!!.jsonPrimitive.content)
        a.deactivate()
        runCurrent()
        assertFalse(stream.isSettled, "background work survives deactivation")
        assertTrue(a.hasLiveBackgroundDeviceWork)

        // The pin cap (1 module) refuses a second module's background work.
        var otherDevice: DeviceContext? = null
        val b = ModuleInstance(MockEngine(), definition(onActivated = { _, ctx -> otherDevice = ctx?.device }), globalContext = gc(h), scope = backgroundScope)
        b.activate()
        val refused = otherDevice!!.stream(Capability.BLUETOOTH_SCAN, BluetoothScanParams, DeviceRequestOptions(lifetime = Lifetime.BACKGROUND)) { }
        assertEquals(DeviceErrorCode.THROTTLED, refused.await().errorOrNull()?.code)

        a.destroy()
        assertEquals(DeviceErrorCode.CANCELLED, stream.await().errorOrNull()?.code)
        assertFalse(a.hasLiveBackgroundDeviceWork)
        h.plane.close()
    }

    @Test
    fun `a suspend action handler is a handler scope - orphaned unary work is cancelled`() = runTest {
        val h = plane()
        h.client.driver("permission.request") { cancelled.await() }
        val orphan = CompletableDeferred<DeviceResult<PermissionStatus>>()
        val engine = MockEngine()
        val def = definition(async = mapOf("go" to { ctx ->
            // Started in another coroutine and NOT awaited by the handler.
            backgroundScope.launch { orphan.complete(ctx.device.permissions.request(Permission.CAMERA)) }
            delay(10)
        }))
        val m = ModuleInstance(engine, def, globalContext = gc(h), scope = backgroundScope)
        m.activate()
        engine.dispatchAction("go", null)
        assertEquals(DeviceErrorCode.CANCELLED, orphan.await().errorOrNull()?.code)
        h.plane.close()
    }

    @Test
    fun `awaited work in a suspend handler completes and state follows`() = runTest {
        val h = plane()
        h.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        val engine = MockEngine()
        val done = CompletableDeferred<Unit>()
        val def = definition(async = mapOf("q" to { ctx ->
            ctx.state.set("r", ctx.device.permissions.query(Permission.MICROPHONE).getOrThrow().wireName)
            done.complete(Unit)
        }))
        val m = ModuleInstance(engine, def, globalContext = gc(h), scope = backgroundScope)
        m.activate()
        engine.dispatchAction("q", null)
        done.await()
        assertEquals("granted", m.getState()["r"])
        h.plane.close()
    }

    @Test
    fun `replayed dispatches cannot reach the device, even after suspending`() = runTest {
        val h = plane()
        h.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        val engine = MockEngine()
        val results = mutableListOf<DeviceResult<PermissionStatus>>()
        val finished = kotlinx.coroutines.channels.Channel<Unit>(2)
        val def = definition(async = mapOf("q" to { ctx ->
            delay(50) // provenance survives suspension
            results += ctx.device.permissions.query(Permission.CAMERA)
            finished.send(Unit)
        }))
        val m = ModuleInstance(engine, def, globalContext = gc(h), scope = backgroundScope)
        m.activate()
        m.runReplayed { engine.dispatchAction("q", null) }
        engine.dispatchAction("q", null)
        finished.receive()
        finished.receive()
        assertEquals(2, results.size)
        assertTrue(results.contains(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "syncActions.replay")))
        assertTrue(results.any { it.isOk })
        assertEquals(1, h.client.requests("permission.query").size, "the replayed dispatch sent nothing")
        h.plane.close()
    }

    @Test
    fun `attaching a plane to an active instance registers its activation, detaching disables`() = runTest {
        val h = plane()
        val gc = HypenGlobalContext()
        var device: DeviceContext? = null
        val m = ModuleInstance(MockEngine(), definition(onActivated = { _, ctx -> device = ctx?.device }), globalContext = gc, scope = backgroundScope)
        m.activate()
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "device-disabled"), device!!.permissions.query(Permission.CAMERA))
        m.attachDevice(h.plane)
        assertTrue(h.plane.ownerIsActive(m.deviceInstanceId, 1u))
        assertTrue(m.createDeviceContext().supports(Capability.GALLERY_PICK))
        m.attachDevice(null)
        assertEquals(DeviceErrorCode.UNAVAILABLE, m.createDeviceContext().permissions.query(Permission.CAMERA).errorOrNull()?.code)
        h.plane.close()
    }

    @Test
    fun `router route modules bind to the connection plane and navigation sweeps their activation`() = runTest {
        HypenApp.clear()
        try {
            val h = plane()
            h.client.driver("gallery.pick") { cancelled.await() }
            var pageDevice: DeviceContext? = null
            HypenApp.register(
                "Page",
                AppBuilder(mutableMapOf<String, Any?>()).onActivated { _, ctx -> pageDevice = ctx?.device }.build().copy(name = "page"),
            )
            HypenApp.register("Other", AppBuilder(mutableMapOf<String, Any?>()).build().copy(name = "other"))
            val router = HypenRouter()
            val managed = ManagedRouter(router, MockEngine(), HypenApp, gc(h), backgroundScope)
            managed.addRoute(RouteDefinition("/", "Page")).addRoute(RouteDefinition("/other", "Other"))
            managed.start()
            val page = assertNotNull(managed.getActiveModule())
            assertTrue(h.plane.ownerIsActive(page.deviceInstanceId, 1u))
            val pick = async { pageDevice!!.gallery.pick(space.hypen.remote.device.GalleryPickParams(listOf(space.hypen.remote.device.MediaType.PHOTO), 1)) }
            runCurrent()
            router.push("/other")
            assertEquals(DeviceResult.Err(DeviceErrorCode.CANCELLED), pick.await())
            // Persisted (off-screen) and active modules are both live instances.
            assertEquals(2, managed.liveInstances().size)
            router.push("/")
            assertTrue(h.plane.ownerIsActive(page.deviceInstanceId, 2u), "a re-mount is a fresh activation")
            managed.stop()
            h.plane.close()
        } finally {
            HypenApp.clear()
        }
    }
}
