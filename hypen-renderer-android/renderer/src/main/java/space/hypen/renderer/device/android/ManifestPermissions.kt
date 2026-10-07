package space.hypen.renderer.device.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import space.hypen.renderer.device.DeclaredPermissions

/**
 * The app's `<uses-permission>` declarations as the OS applies them on this
 * device, read once from [PackageManager] (`PackageInfo.requestedPermissions`
 * / `requestedPermissionsFlags`). Entries whose `android:maxSdkVersion` is
 * below the running API level are already absent there, so the per-API-level
 * requirements of [space.hypen.renderer.device.PermissionNames] (e.g. fine
 * location for BLE only up to API 30) are checked against exactly what
 * applies. Declarations are fixed for an installed APK, so they are read once.
 *
 * It exposes declarations only — never grants or request history — and is
 * the manifest input of the advertisement rule
 * ([space.hypen.renderer.device.CapabilityAdvertisement]). An unreadable
 * package declares nothing (capabilities that need a permission are then not
 * offered rather than offered and failing).
 */
internal class ManifestPermissions(
    override val sdkInt: Int,
    requested: Array<String>?,
    private val flags: IntArray?,
) : DeclaredPermissions {
    private val names: List<String> = requested?.toList().orEmpty()
    private val declared: Set<String> = names.toSet()

    override fun isDeclared(permission: String): Boolean = permission in declared

    /**
     * [permission] is declared with `android:usesPermissionFlags="neverForLocation"`
     * (API 31+; always false below, where the flag does not exist).
     */
    @SuppressLint("InlinedApi") // a compile-time flag value, read only when sdkInt >= 31
    fun neverForLocation(permission: String): Boolean {
        if (sdkInt < Build.VERSION_CODES.S) return false
        val i = names.indexOf(permission)
        val f = flags ?: return false
        return i >= 0 && i < f.size && (f[i] and PackageInfo.REQUESTED_PERMISSION_NEVER_FOR_LOCATION) != 0
    }

    companion object {
        /** Read [context]'s package declarations at [sdkInt] (default: the running API level). */
        fun read(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): ManifestPermissions = try {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            ManifestPermissions(sdkInt, info.requestedPermissions, info.requestedPermissionsFlags)
        } catch (_: Exception) {
            ManifestPermissions(sdkInt, null, null)
        }
    }
}
