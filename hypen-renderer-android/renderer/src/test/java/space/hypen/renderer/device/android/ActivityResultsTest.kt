@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device.android

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.contract.ActivityResultContract
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.device.DeviceDriverException
import space.hypen.renderer.device.DeviceErrorCode

/** `launchForResult` never leaks its launcher or lifecycle listeners when the launch fails (review finding #17). */
class ActivityResultsTest {
    private object Contract : ActivityResultContract<String, String>() {
        override fun createIntent(context: Context, input: String): Intent = throw UnsupportedOperationException()

        override fun parseResult(resultCode: Int, intent: Intent?): String = ""
    }

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun launchFailing(failure: Throwable): Triple<DeviceDriverException, ActivityResultLauncher<String>, ForegroundActivityTracker> {
        val tracker = ForegroundActivityTracker(mockk<Application>(relaxed = true))
        val launcher = mockk<ActivityResultLauncher<String>>(relaxed = true)
        every { launcher.launch(any()) } throws failure
        val registry = mockk<ActivityResultRegistry>()
        every { registry.register(any<String>(), any<ActivityResultContract<String, String>>(), any()) } returns launcher
        val activity = mockk<ComponentActivity>(relaxed = true)
        every { activity.activityResultRegistry } returns registry
        every { activity.isDestroyed } returns false
        var caught: DeviceDriverException? = null
        runTest {
            try {
                launchForResult(tracker, activity, Contract, "input")
            } catch (e: DeviceDriverException) {
                caught = e
            }
        }
        return Triple(caught!!, launcher, tracker)
    }

    @Test
    fun `any launch failure settles unavailable and unregisters everything`() {
        for ((failure, detail) in listOf(
            IllegalStateException("launcher not registered") to "launch-failed",
            SecurityException("not exported") to "launch-failed",
            android.content.ActivityNotFoundException("no picker") to "no-activity-for-intent",
        )) {
            val (e, launcher, tracker) = launchFailing(failure)
            assertEquals(DeviceErrorCode.UNAVAILABLE, e.code)
            assertEquals(detail, e.detail)
            verify(exactly = 1) { launcher.unregister() }
            assertEquals(0, tracker.destroyListenerCount)
            assertEquals(0, tracker.createListenerCount)
        }
    }
}
