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
 * Configurable logger for Hypen framework.
 *
 * Usage:
 * ```kotlin
 * // Enable debug logging
 * HypenLogger.setDebugMode(true)
 *
 * // Or set a specific level
 * HypenLogger.setLogLevel(HypenLogLevel.INFO)
 * ```
 */
object HypenLogger {
    /** Current log level (default: error-only) */
    @Volatile
    var level: HypenLogLevel = HypenLogLevel.ERROR
        private set

    /** Enable or disable debug mode */
    fun setDebugMode(enabled: Boolean) {
        level = if (enabled) HypenLogLevel.DEBUG else HypenLogLevel.ERROR
    }

    /** Set the log level */
    fun setLogLevel(level: HypenLogLevel) {
        this.level = level
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
            Log.d(tag, formatMessage(message, args))
        }
    }

    /** Lazy variant: the message is only built when debug logging is enabled. */
    inline fun debug(message: () -> String) {
        if (HypenLogger.shouldLog(HypenLogLevel.DEBUG)) {
            Log.d(tag, message())
        }
    }

    fun info(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.INFO)) {
            Log.i(tag, formatMessage(message, args))
        }
    }

    fun warn(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.WARN)) {
            Log.w(tag, formatMessage(message, args))
        }
    }

    /** Lazy variant: the message is only built when warn logging is enabled. */
    inline fun warn(message: () -> String) {
        if (HypenLogger.shouldLog(HypenLogLevel.WARN)) {
            Log.w(tag, message())
        }
    }

    fun error(message: String, vararg args: Any?) {
        if (HypenLogger.shouldLog(HypenLogLevel.ERROR)) {
            Log.e(tag, formatMessage(message, args))
        }
    }

    fun error(message: String, throwable: Throwable) {
        if (HypenLogger.shouldLog(HypenLogLevel.ERROR)) {
            Log.e(tag, message, throwable)
        }
    }

    /** Create a child logger with a sub-tag */
    fun child(subTag: String): TaggedLogger {
        return TaggedLogger("$tag:$subTag")
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
