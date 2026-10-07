package space.hypen.renderer

import android.app.Application
import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import space.hypen.renderer.device.*
import space.hypen.renderer.device.android.AndroidPermissionPlatform
import space.hypen.renderer.device.android.ForegroundActivityTracker
import space.hypen.renderer.remote.*

/** Real Android permission implementation + OkHttp + the TS server/Rust broker. */
class DeviceNativeSocketTest {
    @Test fun nativePermissionQueryOverWebSocket() = runBlocking {
        val url = InstrumentationRegistry.getArguments().getString("deviceServerUrl")
        assumeNotNull(url)
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val tracker = ForegroundActivityTracker(app)
        val permissions = AndroidPermissionPlatform(app, tracker, app.getSharedPreferences("device-probe", Context.MODE_PRIVATE))
        val host = DeviceHost(DeviceHostConfig(origin = url!!), listOf(PermissionQueryDriver(permissions)), Dispatchers.Main)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false,
            headers = mapOf("Authorization" to "Bearer native-probe")), deviceHost = host)
        try {
            val connected = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(15_000) { engine.sessionEstablished.first() } }
            engine.connect()
            assertNotNull(connected.await().resumeToken)
            val response = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(15_000) { engine.patches.first { patches -> patches.any { it.value?.toString()?.startsWith("native-probe:") == true } } }
            }
            engine.dispatchAction("probe")
            val text = response.await().first { it.value?.toString()?.startsWith("native-probe:") == true }.value.toString()
            assertTrue(text, text.contains("\"supported\":true"))
            assertTrue(text, text.contains("\"ok\":true"))
            assertTrue(text, text.contains("\"status\":"))
        } finally {
            engine.disconnect()
            withContext(Dispatchers.Main) { host.dispose() }
        }
    }
}
