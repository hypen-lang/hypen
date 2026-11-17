package space.hypen.renderer.remote

/**
 * A system color scheme as the Remote UI protocol names it
 * (`hello.colorScheme` and the `colorScheme` message): what a server-side
 * theme follows while its preference is "system".
 */
enum class HypenColorScheme(
    /** The value on the wire. */
    val wireName: String,
) {
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        /** Night bits of `android.content.res.Configuration.uiMode` (`UI_MODE_NIGHT_MASK`). */
        private const val UI_MODE_NIGHT_MASK = 0x30

        /** `Configuration.UI_MODE_NIGHT_YES`. */
        private const val UI_MODE_NIGHT_YES = 0x20

        /**
         * The scheme a `Configuration.uiMode` describes: [DARK] when its night
         * bits say "night yes", [LIGHT] otherwise (night no / undefined).
         */
        fun fromUiMode(uiMode: Int): HypenColorScheme =
            if ((uiMode and UI_MODE_NIGHT_MASK) == UI_MODE_NIGHT_YES) DARK else LIGHT
    }
}

/**
 * What a connection reports to the server as the system color scheme
 * ([RemoteEngineConfig.colorScheme]).
 */
enum class ColorSchemeReporting {
    /**
     * Follow the device (default). `HypenApp` reads the hosting Activity's
     * configuration (`uiMode` night bits) and reports changes as they happen.
     * A [RemoteEngine] used on its own has no Android context: it reports
     * nothing until [RemoteEngine.setColorScheme] is called.
     */
    AUTO,

    /** Always report light. */
    LIGHT,

    /** Always report dark. */
    DARK,

    /** Report nothing (unless the host calls [RemoteEngine.setColorScheme] itself). */
    OFF,
    ;

    /** The fixed scheme this option names, or null for [AUTO] / [OFF]. */
    val fixedScheme: HypenColorScheme?
        get() = when (this) {
            LIGHT -> HypenColorScheme.LIGHT
            DARK -> HypenColorScheme.DARK
            AUTO, OFF -> null
        }
}
