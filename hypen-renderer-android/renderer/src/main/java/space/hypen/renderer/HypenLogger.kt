package space.hypen.renderer

import android.util.Log

/**
 * Log level for controlling what messages are shown
 */
enum class HypenLogLevel(val priority: Int) {
    DEBUG(0),
    INFO(1),
    WARN(2),
    ERROR(3),
    NONE(4)
}

/**
 * Sink for Hypen log output.
 *
 * Install one with [HypenLogger.setLogHandler] to route framework logs into your
 * own logging stack (Timber, Crashlytics, a file, a test recorder, ...) instead
 * of `android.util.Log`. Messages arrive already formatted; [throwable] is
 * non-null only for the throwable-carrying `error(message, throwable)` overload.
 *
 * Level filtering happens before the handler is called, so a handler never sees
 * a message that the configured [HypenLogger.level] filters out, and lazy
 * message lambdas are still skipped entirely when filtered.
 *
 * Declared as a `fun interface` so Kotlin callers can pass a lambda:
 * ```kotlin
 * HypenLogger.setLogHandler { level, tag, message, throwable ->
 *     Timber.tag(tag).log(level.toTimberPriority(), throwable, message)
 * }
 * ```
 */
fun interface HypenLogHandler {
    fun log(level: HypenLogLevel, tag: String, message: String, throwable: Throwable?)
}

/**
 * Configurable logger for Hypen framework.
 *
 * Usage:
 * ```kotlin
 * // Enable debug logging
 * HypenLogger.setDebugMode(true)
 *
 * // Or set a specific level
 * HypenLogger.setLogLevel(HypenLogLevel.INFO)
 *
 * // Route output somewhere other than android.util.Log
 * HypenLogger.setLogHandler { level, tag, message, throwable -> /* ... */ }
 *
 * // Back to android.util.Log
 * HypenLogger.setLogHandler(null)
 * ```
 */
object HypenLogger {
    /** Current log level (default: error-only) */
    @Volatile
    var level: HypenLogLevel = HypenLogLevel.ERROR
        private set

    /**
     * Custom output sink, or `null` (default) to log via `android.util.Log`.
     *
     * @see setLogHandler
     */
    @Volatile
    var handler: HypenLogHandler? = null
        private set

    /** Enable or disable debug mode */
    fun setDebugMode(enabled: Boolean) {
        level = if (enabled) HypenLogLevel.DEBUG else HypenLogLevel.ERROR
    }

    /** Set the log level */
    fun setLogLevel(level: HypenLogLevel) {
        this.level = level
    }

    /**
     * Install a custom log handler, or pass `null` to restore the default
     * `android.util.Log` output. Does not affect level filtering.
     */
    fun setLogHandler(handler: HypenLogHandler?) {
        this.handler = handler
    }

    /** Check if debug mode is enabled */
    val isDebugMode: Boolean
        get() = level == HypenLogLevel.DEBUG

    /** Check if a level should be logged */
    fun shouldLog(logLevel: HypenLogLevel): Boolean {
        return logLevel.priority >= level.priority
    }
}

/**
 * Tagged logger for specific components
 */
class TaggedLogger(@PublishedApi internal val tag: String) {

    fun debug(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.DEBUG)) {
            emit(HypenLogLevel.DEBUG, formatMessage(message, args), null)
        }
    }

    /** Lazy variant: the message is only built when debug logging is enabled. */
    inline fun debug(message: () -> String) {
        if (HypenLogger.shouldLog(HypenLogLevel.DEBUG)) {
            emit(HypenLogLevel.DEBUG, message(), null)
        }
    }

    fun info(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.INFO)) {
            emit(HypenLogLevel.INFO, formatMessage(message, args), null)
        }
    }

    fun warn(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.WARN)) {
            emit(HypenLogLevel.WARN, formatMessage(message, args), null)
        }
    }

    /** Lazy variant: the message is only built when warn logging is enabled. */
    inline fun warn(message: () -> String) {
        if (HypenLogger.shouldLog(HypenLogLevel.WARN)) {
            emit(HypenLogLevel.WARN, message(), null)
        }
    }

    fun error(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.ERROR)) {
            emit(HypenLogLevel.ERROR, formatMessage(message, args), null)
        }
    }

    fun error(message: String, throwable: Throwable) {
        if (HypenLogger.shouldLog(HypenLogLevel.ERROR)) {
            emit(HypenLogLevel.ERROR, message, throwable)
        }
    }

    /** Create a child logger with a sub-tag */
    fun child(subTag: String): TaggedLogger {
        return TaggedLogger("$tag:$subTag")
    }

    /**
     * Route an already-formatted, already-level-filtered message to the
     * installed [HypenLogHandler], falling back to `android.util.Log`.
     *
     * Internal plumbing — `@PublishedApi` only so the public `inline` lazy
     * overloads above can call it. Not part of the supported API surface.
     */
    @PublishedApi
    internal fun emit(level: HypenLogLevel, message: String, throwable: Throwable?) {
        val handler = HypenLogger.handler
        if (handler != null) {
            handler.log(level, tag, message, throwable)
            return
        }
        when (level) {
            HypenLogLevel.DEBUG -> Log.d(tag, message)
            HypenLogLevel.INFO -> Log.i(tag, message)
            HypenLogLevel.WARN -> Log.w(tag, message)
            HypenLogLevel.ERROR ->
                if (throwable != null) Log.e(tag, message, throwable) else Log.e(tag, message)
            HypenLogLevel.NONE -> {}
        }
    }

    private fun formatMessage(message: String, args: Array<out Any?>): String {
        return if (args.isEmpty()) message else String.format(message, *args)
    }
}

/**
 * Predefined loggers for framework components
 */
object HypenLoggers {
    val app = TaggedLogger("HypenApp")
    val renderer = TaggedLogger("HypenRenderer")
    val remote = TaggedLogger("HypenRemote")
    val components = TaggedLogger("HypenComponents")
}
