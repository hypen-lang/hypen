package space.hypen.remote.device

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File

/**
 * Locates the shared cross-SDK fixture tree (`engine-compatibility-tests/`).
 *
 * Defaults to the sibling checkout like every other compatibility runner in
 * this SDK; `HYPEN_COMPAT_TESTS_DIR` overrides it for out-of-tree runs.
 */
internal object DeviceFixtures {
    val compatRoot: File by lazy {
        val override = System.getenv("HYPEN_COMPAT_TESTS_DIR")?.takeIf { it.isNotBlank() }
        val root = if (override != null) File(override) else File("../engine-compatibility-tests")
        check(root.isDirectory) {
            "engine-compatibility-tests dir missing: ${root.absolutePath} (set HYPEN_COMPAT_TESTS_DIR to override)"
        }
        root
    }

    val deviceFixtures: File by lazy {
        File(compatRoot, "fixtures/device").also {
            check(it.isDirectory) { "device fixtures dir missing: ${it.absolutePath}" }
        }
    }

    val deviceSchemas: File by lazy {
        File(compatRoot, "schema/device").also {
            check(it.isDirectory) { "device schema dir missing: ${it.absolutePath}" }
        }
    }

    /**
     * Load a fixture file. Fixtures are NOT device messages (they may exceed
     * the device limits), but a duplicate key anywhere is a fixture error:
     * kotlinx would silently keep the last value.
     */
    fun load(file: File): JsonElement {
        val text = file.readText(Charsets.UTF_8)
        duplicateKey(text)?.let { error("${file.name}: duplicate key \"$it\" in fixture") }
        return Json.parseToJsonElement(text)
    }

    /** First duplicated object key in well-formed JSON [text] (compared after unescaping), or `null`. */
    fun duplicateKey(text: String): String? {
        val stack = ArrayList<MutableSet<String>?>()
        var expectKey = false
        var i = 0
        while (i < text.length) {
            when (val c = text[i]) {
                '"' -> {
                    val sb = StringBuilder()
                    var j = i + 1
                    while (j < text.length && text[j] != '"') {
                        if (text[j] == '\\') {
                            val e = text[j + 1]
                            if (e == 'u') {
                                sb.append(text.substring(j + 2, j + 6).toInt(16).toChar())
                                j += 6
                                continue
                            }
                            sb.append(
                                when (e) {
                                    'n' -> '\n'
                                    't' -> '\t'
                                    'r' -> '\r'
                                    'b' -> '\b'
                                    'f' -> '\u000C'
                                    else -> e
                                },
                            )
                            j += 2
                        } else {
                            sb.append(text[j])
                            j += 1
                        }
                    }
                    val top = stack.lastOrNull()
                    if (expectKey && top != null) {
                        if (!top.add(sb.toString())) return sb.toString()
                        expectKey = false
                    }
                    i = j + 1
                    continue
                }
                '{', '[' -> {
                    stack += if (c == '{') HashSet() else null
                    expectKey = c == '{'
                }
                '}', ']' -> {
                    stack.removeAt(stack.size - 1)
                    expectKey = false
                }
                ',' -> expectKey = stack.lastOrNull() != null
            }
            i += 1
        }
        return null
    }

    /**
     * The exact bytes a text case (`raw`, `rawHex`, `rawRepeat`) stands for,
     * or `null` for a value case (`message` / `value`). Exactly one form.
     */
    fun caseBytes(case: JsonObject): ByteArray? {
        val forms = listOf("message", "raw", "rawHex", "rawRepeat", "value").count { it in case }
        check(forms == 1) { "${case["name"]}: exactly one case form, got $forms" }
        case["raw"]?.let { return it.jsonPrimitive.content.toByteArray(Charsets.UTF_8) }
        case["rawHex"]?.let { return hexDecode(it.jsonPrimitive.content) }
        case["rawRepeat"]?.let { rep ->
            val r = rep.jsonObject
            val text = r["prefix"]!!.jsonPrimitive.content +
                r["repeat"]!!.jsonPrimitive.content.repeat(r["count"]!!.jsonPrimitive.long.toInt()) +
                r["suffix"]!!.jsonPrimitive.content
            return text.toByteArray(Charsets.UTF_8)
        }
        return null
    }

    /** Strict UTF-8 decode, or `null` for bytes that are not UTF-8. */
    fun utf8OrNull(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        null
    }

    fun hexDecode(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd-length hex" }
        return ByteArray(hex.length / 2) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
    }

    fun hexEncode(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
