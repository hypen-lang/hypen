package space.hypen.renderer.model

/**
 * Represents a Hypen UI element in the render tree.
 * This is the internal representation used by the renderer.
 */
data class HypenElement(
    val id: String,
    val elementType: String,
    val props: MutableMap<String, Any?> = mutableMapOf(),
    val children: MutableList<String> = mutableListOf(),
    var parentId: String? = null,
    var textContent: String? = null,
    /**
     * Engine-derived accessibility semantics: set at CREATE, replaced
     * wholesale by SET_SEMANTICS reactive re-emits (null clears). Translated
     * to `Modifier.semantics {}` in [space.hypen.renderer.render.applyHypenSemantics].
     */
    var semantics: Map<String, Any?>? = null,
) {
    /**
     * Gets a property value with type casting.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> getProp(name: String): T? = props[name] as? T

    /**
     * Gets a property value with a default.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> getProp(
        name: String,
        default: T,
    ): T = (props[name] as? T) ?: default

    /**
     * Gets a string property.
     */
    fun getStringProp(name: String): String? = props[name]?.toString()

    /**
     * Gets a string property with a default.
     */
    fun getStringProp(
        name: String,
        default: String,
    ): String = getStringProp(name) ?: default

    /**
     * Gets a numeric property as Double.
     */
    fun getDoubleProp(name: String): Double? =
        when (val value = props[name]) {
            is Number -> value.toDouble()
            is String -> {
                val str = value.trim().lowercase()
                when {
                    str.endsWith("rem") -> str.removeSuffix("rem").toDoubleOrNull()?.times(16.0)
                    str.endsWith("em") -> str.removeSuffix("em").toDoubleOrNull()?.times(16.0)
                    str.endsWith("px") -> str.removeSuffix("px").toDoubleOrNull()
                    str.endsWith("dp") -> str.removeSuffix("dp").toDoubleOrNull()
                    str.endsWith("pt") -> str.removeSuffix("pt").toDoubleOrNull()
                    else -> value.toDoubleOrNull()
                }
            }
            else -> null
        }

    /**
     * Gets a numeric property as Float.
     */
    fun getFloatProp(name: String): Float? = getDoubleProp(name)?.toFloat()

    /**
     * Gets a numeric property as Int.
     */
    fun getIntProp(name: String): Int? =
        when (val value = props[name]) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }

    /**
     * Gets a boolean property.
     */
    fun getBoolProp(name: String): Boolean? =
        when (val value = props[name]) {
            is Boolean -> value
            is String -> value.toBooleanStrictOrNull()
            else -> null
        }

    /**
     * Gets a boolean property with a default.
     */
    fun getBoolProp(
        name: String,
        default: Boolean,
    ): Boolean = getBoolProp(name) ?: default
}

/**
 * Represents the state of an action (e.g., onClick value).
 */
data class ActionValue(
    val actionName: String,
    val payload: Map<String, Any?> = emptyMap(),
) {
    companion object {
        /**
         * Parse an action value from a property value.
         * Supports both string format "@actions.name" and object format.
         */
        fun parse(value: Any?): ActionValue? =
            when (value) {
                is String -> parseString(value)
                is Map<*, *> -> parseMap(value)
                else -> null
            }

        private fun parseString(value: String): ActionValue? {
            if (!value.startsWith("@")) return null
            var actionName = value.substring(1)
            if (actionName.startsWith("actions.")) {
                actionName = actionName.substring(8)
            }
            return ActionValue(actionName)
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseMap(value: Map<*, *>): ActionValue? {
            // Support both "0" (JSON convention) and "action" (DSL-friendly) keys
            val actionValue = (value["0"] ?: value["action"]) as? String ?: return null
            val parsed = parseString(actionValue) ?: return null

            val payload =
                value
                    .filterKeys { it != "0" && it != "action" }
                    .mapKeys { it.key.toString() }
                    .mapValues { it.value } as Map<String, Any?>

            return ActionValue(parsed.actionName, payload)
        }
    }
}
