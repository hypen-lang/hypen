package space.hypen.gallery

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * Manages persistent storage of Hypen app entries using SharedPreferences.
 */
class AppStorage(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun getRecentApps(): List<HypenAppEntry> {
        val jsonStr = prefs.getString(KEY_APPS, null) ?: return emptyList()
        return try {
            json.decodeFromString<List<HypenAppEntry>>(jsonStr)
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun saveApp(entry: HypenAppEntry) {
        val apps = getRecentApps().toMutableList()

        // Remove existing entry with same URL if present
        apps.removeAll { it.url == entry.url }

        // Add new entry at the beginning
        apps.add(0, entry)

        // Keep only the most recent MAX_APPS entries
        val trimmed = apps.take(MAX_APPS)

        saveApps(trimmed)
    }

    fun addOrUpdateApp(name: String, url: String): HypenAppEntry {
        val existing = getRecentApps().find { it.url == url }
        val entry = existing?.copy(
            name = name,
            lastConnected = System.currentTimeMillis()
        ) ?: HypenAppEntry(
            id = UUID.randomUUID().toString(),
            name = name,
            url = url,
            lastConnected = System.currentTimeMillis()
        )
        saveApp(entry)
        return entry
    }

    fun removeApp(id: String) {
        val apps = getRecentApps().filterNot { it.id == id }
        saveApps(apps)
    }

    fun clearAll() {
        prefs.edit().remove(KEY_APPS).apply()
    }

    private fun saveApps(apps: List<HypenAppEntry>) {
        val jsonStr = json.encodeToString(apps)
        prefs.edit().putString(KEY_APPS, jsonStr).apply()
    }

    companion object {
        private const val PREFS_NAME = "hypen_gallery_apps"
        private const val KEY_APPS = "recent_apps"
        private const val MAX_APPS = 50
    }
}
