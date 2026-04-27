package space.hypen.core

import kotlinx.serialization.json.*

/**
 * Convert any value to a JsonElement
 */
fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is String -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(
        this.entries.associate { (k, v) ->
            k.toString() to v.toJsonElement()
        }
    )
    is List<*> -> JsonArray(this.map { it.toJsonElement() })
    is Array<*> -> JsonArray(this.map { it.toJsonElement() })
    else -> JsonPrimitive(this.toString())
}

/**
 * Convert a JsonElement to a Kotlin value
 */
fun JsonElement.toKotlinValue(): Any? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> {
        when {
            isString -> content
            content == "true" -> true
            content == "false" -> false
            content.contains(".") -> content.toDoubleOrNull() ?: content
            else -> content.toIntOrNull() ?: content.toLongOrNull() ?: content
        }
    }
    is JsonObject -> this.mapValues { it.value.toKotlinValue() }
    is JsonArray -> this.map { it.toKotlinValue() }
}

/**
 * Deep clone a map
 */
@Suppress("UNCHECKED_CAST")
fun deepCloneMap(map: Map<String, Any?>): Map<String, Any?> {
    return map.mapValues { (_, value) ->
        when (value) {
            is Map<*, *> -> deepCloneMap(value as Map<String, Any?>)
            is List<*> -> value.map { item ->
                when (item) {
                    is Map<*, *> -> deepCloneMap(item as Map<String, Any?>)
                    else -> item
                }
            }
            else -> value
        }
    }
}

/**
 * Compare two values for deep equality
 */
fun deepEquals(a: Any?, b: Any?): Boolean {
    if (a === b) return true
    if (a == null || b == null) return a == b

    return when {
        a is Map<*, *> && b is Map<*, *> -> {
            if (a.size != b.size) return false
            a.entries.all { (key, value) ->
                b.containsKey(key) && deepEquals(value, b[key])
            }
        }
        a is List<*> && b is List<*> -> {
            if (a.size != b.size) return false
            a.zip(b).all { (aItem, bItem) -> deepEquals(aItem, bItem) }
        }
        a is Number && b is Number -> {
            a.toDouble() == b.toDouble()
        }
        else -> a == b
    }
}
