package space.hypen.core

/**
 * Log levels in ascending severity order.
 */
enum class LogLevel(val priority: Int) {
    DEBUG(0),
    INFO(1),
    WARN(2),
    ERROR(3),
    NONE(4)
}

/**
 * Custom log handler for routing log output.
 */
interface LogHandler {
    fun debug(tag: String, message: String, args: List<Any?>)
    fun info(tag: String, message: String, args: List<Any?>)
    fun warn(tag: String, message: String, args: List<Any?>)
    fun error(tag: String, message: String, args: List<Any?>)
}

/**
 * Logger configuration.
 */
data class LoggerConfig(
    val level: LogLevel = LogLevel.INFO,
    val colors: Boolean = true,
    val timestamps: Boolean = false,
    val handler: LogHandler? = null
)

/**
 * Tagged logger with level filtering.
 *
 * ```kotlin
 * val log = createLogger("Engine")
 * log.debug("rendering source...")
 * log.info("module created", moduleName)
 * log.time("render") { engine.renderSource(source) }
 * ```
 */
class Logger(val tag: String) {

    fun debug(message: String, vararg args: Any?) {
        log(LogLevel.DEBUG, message, args.toList())
    }

    fun info(message: String, vararg args: Any?) {
        log(LogLevel.INFO, message, args.toList())
    }

    fun warn(message: String, vararg args: Any?) {
        log(LogLevel.WARN, message, args.toList())
    }

    fun error(message: String, vararg args: Any?) {
        log(LogLevel.ERROR, message, args.toList())
    }

    /**
     * Time a synchronous operation and log the duration.
     */
    fun <T> time(label: String, block: () -> T): T {
        val start = System.nanoTime()
        val result = block()
        val elapsed = (System.nanoTime() - start) / 1_000_000.0
        debug("$label took %.2fms".format(elapsed))
        return result
    }

    /**
     * Time a suspend operation and log the duration.
     */
    suspend fun <T> timeAsync(label: String, block: suspend () -> T): T {
        val start = System.nanoTime()
        val result = block()
        val elapsed = (System.nanoTime() - start) / 1_000_000.0
        debug("$label took %.2fms".format(elapsed))
        return result
    }

    /**
     * Create a child logger with a sub-tag.
     */
    fun child(subTag: String): Logger = Logger("$tag:$subTag")

    /**
     * Log only if condition is true.
     */
    fun debugIf(condition: Boolean, message: String, vararg args: Any?) {
        if (condition) debug(message, *args)
    }

    fun warnIf(condition: Boolean, message: String, vararg args: Any?) {
        if (condition) warn(message, *args)
    }

    fun errorIf(condition: Boolean, message: String, vararg args: Any?) {
        if (condition) error(message, *args)
    }

    /**
     * Log a warning only once per key (across the lifetime of this logger).
     */
    fun warnOnce(key: String, message: String, vararg args: Any?) {
        if (onceKeys.add(key)) warn(message, *args)
    }

    fun debugOnce(key: String, message: String, vararg args: Any?) {
        if (onceKeys.add(key)) debug(message, *args)
    }

    private val onceKeys = mutableSetOf<String>()

    private fun log(level: LogLevel, message: String, args: List<Any?>) {
        if (level.priority < globalConfig.level.priority) return

        val handler = globalConfig.handler
        if (handler != null) {
            when (level) {
                LogLevel.DEBUG -> handler.debug(tag, message, args)
                LogLevel.INFO -> handler.info(tag, message, args)
                LogLevel.WARN -> handler.warn(tag, message, args)
                LogLevel.ERROR -> handler.error(tag, message, args)
                LogLevel.NONE -> {}
            }
            return
        }

        val prefix = buildPrefix(level)
        val argsStr = if (args.isNotEmpty()) " " + args.joinToString(" ") else ""
        val output = "$prefix $message$argsStr"

        if (level == LogLevel.ERROR) {
            System.err.println(output)
        } else {
            println(output)
        }
    }

    private fun buildPrefix(level: LogLevel): String {
        val timestamp = if (globalConfig.timestamps) {
            val now = java.time.LocalTime.now().toString().substringBefore(".")
            "[$now] "
        } else ""

        return if (globalConfig.colors) {
            val color = when (level) {
                LogLevel.DEBUG -> "\u001b[36m" // cyan
                LogLevel.INFO -> "\u001b[32m"  // green
                LogLevel.WARN -> "\u001b[33m"  // yellow
                LogLevel.ERROR -> "\u001b[31m" // red
                LogLevel.NONE -> ""
            }
            val reset = "\u001b[0m"
            "$timestamp$color[${level.name}]$reset [$tag]"
        } else {
            "$timestamp[${level.name}] [$tag]"
        }
    }

    companion object {
        @Volatile
        private var globalConfig = LoggerConfig()

        fun setLogLevel(level: LogLevel) {
            globalConfig = globalConfig.copy(level = level)
        }

        fun getLogLevel(): LogLevel = globalConfig.level

        fun configure(config: LoggerConfig) {
            globalConfig = config
        }

        fun configure(block: LoggerConfig.() -> LoggerConfig) {
            globalConfig = globalConfig.block()
        }

        fun enableLogging() = setLogLevel(LogLevel.DEBUG)
        fun disableLogging() = setLogLevel(LogLevel.NONE)
    }
}

fun createLogger(tag: String): Logger = Logger(tag)

/**
 * Pre-defined framework loggers for consistent tagging.
 */
object HypenLoggers {
    val hypen = createLogger("Hypen")
    val engine = createLogger("Engine")
    val router = createLogger("Router")
    val state = createLogger("State")
    val events = createLogger("Events")
    val remote = createLogger("Remote")
    val module = createLogger("Module")
    val lifecycle = createLogger("Lifecycle")
    val loader = createLogger("Loader")
    val context = createLogger("Context")
    val session = createLogger("Session")
    val server = createLogger("Server")
}
