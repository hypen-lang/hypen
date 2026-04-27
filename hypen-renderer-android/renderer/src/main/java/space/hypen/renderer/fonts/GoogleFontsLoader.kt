package space.hypen.renderer.fonts

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import space.hypen.renderer.HypenLoggers

private val log = HypenLoggers.components.child("Fonts")

/**
 * Utility for loading Google Fonts in Compose.
 *
 * Usage in Hypen DSL:
 * - fontFamily("Roboto") - loads Roboto from Google Fonts
 * - fontFamily("Open Sans") - loads Open Sans from Google Fonts
 * - fontFamily("system") - uses system default
 * - fontFamily("serif") - uses system serif
 * - fontFamily("monospace") - uses system monospace
 */
object GoogleFontsLoader {

    // Google Fonts provider
    private val provider = GoogleFont.Provider(
        providerAuthority = "com.google.android.gms.fonts",
        providerPackage = "com.google.android.gms",
        certificates = space.hypen.renderer.R.array.com_google_android_gms_fonts_certs
    )

    // Cache for loaded font families
    private val fontCache = mutableMapOf<String, FontFamily>()

    /**
     * Load a font family by name.
     * Returns null if the font name is a system font keyword.
     */
    fun loadFontFamily(fontName: String): FontFamily? {
        val normalized = fontName.trim()

        // Check cache first
        fontCache[normalized]?.let { return it }

        // Check if it's a system font keyword
        if (isSystemFontKeyword(normalized)) {
            return null // Let caller handle system fonts
        }

        return try {
            val googleFont = GoogleFont(normalized)
            val fontFamily = FontFamily(
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W100),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W200),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W300),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W400),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W500),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W600),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W700),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W800),
                Font(googleFont = googleFont, fontProvider = provider, weight = FontWeight.W900),
            )

            fontCache[normalized] = fontFamily
            log.debug("Loaded Google Font: $normalized")
            fontFamily
        } catch (e: Exception) {
            log.warn("Failed to load Google Font '$normalized': ${e.message}")
            null
        }
    }

    /**
     * Load a specific weight of a Google Font.
     * Useful when you only need one weight variant.
     */
    fun loadFontFamilyWithWeight(fontName: String, weight: FontWeight): FontFamily? {
        val normalized = fontName.trim()
        val cacheKey = "$normalized-${weight.weight}"

        fontCache[cacheKey]?.let { return it }

        if (isSystemFontKeyword(normalized)) {
            return null
        }

        return try {
            val googleFont = GoogleFont(normalized)
            val fontFamily = FontFamily(
                Font(googleFont = googleFont, fontProvider = provider, weight = weight)
            )

            fontCache[cacheKey] = fontFamily
            fontFamily
        } catch (e: Exception) {
            log.warn("Failed to load Google Font '$normalized' with weight ${weight.weight}: ${e.message}")
            null
        }
    }

    /**
     * Check if a font name is a system font keyword.
     */
    fun isSystemFontKeyword(fontName: String): Boolean {
        val normalized = fontName.lowercase()
            .replace(" ", "")
            .replace("-", "")
            .replace("_", "")

        return normalized in setOf(
            "default", "system",
            "serif",
            "sansserif", "sans",
            "monospace", "mono", "courier",
            "cursive"
        )
    }

    /**
     * Get the system FontFamily for a keyword.
     */
    fun getSystemFontFamily(keyword: String): FontFamily? {
        val normalized = keyword.lowercase()
            .replace(" ", "")
            .replace("-", "")
            .replace("_", "")

        return when (normalized) {
            "default", "system" -> FontFamily.Default
            "serif" -> FontFamily.Serif
            "sansserif", "sans" -> FontFamily.SansSerif
            "monospace", "mono", "courier" -> FontFamily.Monospace
            "cursive" -> FontFamily.Cursive
            else -> null
        }
    }

    /**
     * Clear the font cache.
     */
    fun clearCache() {
        fontCache.clear()
    }

    /**
     * Popular Google Fonts for reference.
     * These are commonly used fonts that are known to work well.
     */
    val popularFonts = listOf(
        "Roboto",
        "Open Sans",
        "Lato",
        "Montserrat",
        "Poppins",
        "Inter",
        "Nunito",
        "Playfair Display",
        "Merriweather",
        "Source Code Pro",
        "Fira Code",
        "JetBrains Mono",
        "Raleway",
        "Ubuntu",
        "Oswald",
        "Quicksand",
        "Work Sans",
        "Rubik",
        "Karla",
        "DM Sans",
    )
}
