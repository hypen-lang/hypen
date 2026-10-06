package space.hypen.renderer.remote

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** A device JSON text broke one of the RFC 001 §2.1 JSON limits (decision D4). */
class DeviceJsonException(message: String) : RuntimeException(message)

/**
 * Strict JSON reader for Device Capability Protocol text (RFC 001 §2.1,
 * decision D4): one set of limits for the whole message (envelope and
 * `params`/`result`/`event`) and for the handshake objects, identical in
 * every SDK and pinned by `fixtures/device/conformance/messages.json`.
 *
 * - at most [MAX_DEVICE_JSON_BYTES] bytes of UTF-8, checked **before**
 *   parsing ([utf8Length]);
 * - nesting depth at most [MAX_DEPTH] containers (`{`/`[`; the envelope
 *   object is depth 1; scalars do not count; 33 is rejected);
 * - numbers are integer tokens only, `-?(0|[1-9][0-9]*)`: no fraction,
 *   exponent, `-0`, leading zero or `+`; at most [MAX_INTEGER_DIGITS] digits
 *   and magnitude at most 2^53−1. Every number in a tree is therefore a
 *   [Long] (never a `Double`);
 * - strings (keys and values): no raw control characters (< 0x20), no lone
 *   surrogates (escaped or raw), valid escapes only;
 * - duplicate keys (compared after unescaping) rejected at any depth;
 * - literals exactly `true`, `false`, `null`; JSON whitespace only; no BOM,
 *   no trailing data.
 *
 * Strings must be valid UTF-8 (D4). OkHttp never shows the engine the bytes
 * of a text frame: its WebSocket reader decodes them with Okio's
 * `readUtf8()`, which silently turns every malformed sequence into U+FFFD.
 * Repaired text and text that really contained U+FFFD are then identical, so
 * the only way to refuse invalid UTF-8 on that path is to refuse a **raw**
 * U+FFFD inside a string (key or value) of text whose bytes were not checked
 * (`utf8Verified = false`, the default for wire text). The escaped form
 * `\uFFFD` stays accepted, so a sender that means the replacement character
 * can always express it. This is an Android transport limit (RFC 001 §2.1):
 * raw U+FFFD in a device message is refused as a connection-level violation.
 * [decodeUtf8] is the strict decoder for byte input: a transport (or test)
 * that sees the bytes decodes them with it and parses with
 * `utf8Verified = true`, where raw U+FFFD is ordinary text.
 *
 * Objects are [LinkedHashMap]s (wire order), arrays [ArrayList]s. Every
 * failure throws [DeviceJsonException]; such text is attributable to no
 * request (decision D3/D8): a connection-level violation.
 */
object StrictDeviceJson {
    /** Deepest container nesting accepted (the envelope object is depth 1). */
    const val MAX_DEPTH: Int = 32

    /** Largest device JSON text accepted, in UTF-8 bytes, checked before parsing. */
    const val MAX_DEVICE_JSON_BYTES: Int = 1_048_576

    /** Most digits an integer token may have. */
    const val MAX_INTEGER_DIGITS: Int = 16

    /** Largest integer magnitude (2^53 − 1). */
    const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991

    /** UTF-8 length of [s] without encoding it (a lone surrogate counts as its 3-byte replacement). */
    fun utf8Length(s: String): Long {
        var n = 0L
        var i = 0
        while (i < s.length) {
            val c = s[i]
            n += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    i += 1
                    4
                }
                else -> 3
            }
            i += 1
        }
        return n
    }

    /** Decode [bytes] as strict UTF-8 (malformed or overlong sequences and encoded surrogates are refused). */
    fun decodeUtf8(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        throw DeviceJsonException("invalid UTF-8")
    }

    /**
     * Parse a complete device JSON text (size limit included). [utf8Verified]
     * is true only when [json] came from [decodeUtf8] (or another strict
     * decoder); otherwise a raw U+FFFD in a string may be a silently repaired
     * invalid byte sequence and is refused (see the class doc).
     */
    fun parse(json: String, utf8Verified: Boolean = false): Any? {
        val size = utf8Length(json)
        if (size > MAX_DEVICE_JSON_BYTES) throw DeviceJsonException("text of $size bytes exceeds $MAX_DEVICE_JSON_BYTES")
        return Reader(json, MAX_DEPTH, integersOnly = true, refuseRawReplacement = !utf8Verified).document()
    }

    /**
     * The same grammar without the size and depth limits, and with every
     * JSON number accepted (integers as `Long`, anything else as `Double`),
     * for trusted local documents (test fixtures). Never for wire text.
     */
    internal fun parseTrusted(json: String): Any? = Reader(json, Int.MAX_VALUE, integersOnly = false).document()

    private class Reader(
        private val s: String,
        private val maxDepth: Int,
        private val integersOnly: Boolean,
        private val refuseRawReplacement: Boolean = false,
    ) {
        private var i = 0

        fun document(): Any? {
            if (s.isNotEmpty() && s[0] == '\uFEFF') fail("byte order mark")
            ws()
            val v = value(0)
            ws()
            if (i != s.length) fail("trailing data")
            return v
        }

        private fun fail(what: String): Nothing = throw DeviceJsonException("$what at offset $i")

        private fun ws() {
            while (i < s.length) {
                when (s[i]) {
                    ' ', '\t', '\n', '\r' -> i += 1
                    else -> return
                }
            }
        }

        private fun peek(): Char = if (i < s.length) s[i] else fail("unexpected end of text")

        private fun value(depth: Int): Any? = when (val c = peek()) {
            '{' -> obj(depth + 1)
            '[' -> arr(depth + 1)
            '"' -> string()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", null)
            else -> if (c == '-' || c in '0'..'9') number() else fail("unexpected character")
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) fail("invalid literal")
            i += word.length
            return v
        }

        private fun obj(depth: Int): Map<String, Any?> {
            if (depth > maxDepth) fail("nesting deeper than $maxDepth")
            i += 1
            val out = LinkedHashMap<String, Any?>()
            ws()
            if (peek() == '}') {
                i += 1
                return out
            }
            while (true) {
                ws()
                if (peek() != '"') fail("expected a key")
                val key = string()
                if (out.containsKey(key)) fail("duplicate key '${key.take(64)}'")
                ws()
                if (peek() != ':') fail("expected ':'")
                i += 1
                ws()
                out[key] = value(depth)
                ws()
                when (peek()) {
                    ',' -> i += 1
                    '}' -> {
                        i += 1
                        return out
                    }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun arr(depth: Int): List<Any?> {
            if (depth > maxDepth) fail("nesting deeper than $maxDepth")
            i += 1
            val out = ArrayList<Any?>()
            ws()
            if (peek() == ']') {
                i += 1
                return out
            }
            while (true) {
                ws()
                out += value(depth)
                ws()
                when (peek()) {
                    ',' -> i += 1
                    ']' -> {
                        i += 1
                        return out
                    }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun number(): Any {
            if (!integersOnly) return anyNumber()
            val start = i
            if (s[i] == '-') i += 1
            if (i >= s.length || s[i] !in '0'..'9') fail("invalid number")
            if (s[i] == '0') {
                i += 1
            } else {
                while (i < s.length && s[i] in '0'..'9') i += 1
            }
            if (i < s.length && (s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] in '0'..'9')) fail("not an integer token (fraction, exponent or leading zero)")
            val literal = s.substring(start, i)
            if (literal == "-0") fail("-0 is not an integer token")
            val digits = literal.length - (if (literal[0] == '-') 1 else 0)
            if (digits > MAX_INTEGER_DIGITS) fail("integer longer than $MAX_INTEGER_DIGITS digits")
            val v = literal.toLong()
            if (v > MAX_SAFE_INTEGER || v < -MAX_SAFE_INTEGER) fail("integer beyond 2^53-1")
            return v
        }

        private fun anyNumber(): Any {
            val start = i
            while (i < s.length && (s[i] in '0'..'9' || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i += 1
            val literal = s.substring(start, i)
            val isInteger = Regex("-?(0|[1-9][0-9]*)").matches(literal) && literal != "-0"
            return (if (isInteger) literal.toLongOrNull() else null) ?: literal.toDoubleOrNull() ?: fail("invalid number")
        }

        private fun string(): String {
            i += 1 // opening quote
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i]
                when {
                    c == '"' -> {
                        i += 1
                        return sb.toString()
                    }
                    c.code < 0x20 -> fail("raw control character in a string")
                    c == '\\' -> escape(sb)
                    Character.isHighSurrogate(c) -> {
                        if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) fail("lone surrogate")
                        sb.append(c).append(s[i + 1])
                        i += 2
                    }
                    Character.isLowSurrogate(c) -> fail("lone surrogate")
                    c == '\uFFFD' && refuseRawReplacement ->
                        fail("raw U+FFFD (indistinguishable from repaired invalid UTF-8; escape it as \\uFFFD)")
                    else -> {
                        sb.append(c)
                        i += 1
                    }
                }
            }
        }

        private fun escape(sb: StringBuilder) {
            i += 1
            if (i >= s.length) fail("unterminated escape")
            when (s[i]) {
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                'b' -> sb.append('\b')
                'f' -> sb.append('\u000C')
                'n' -> sb.append('\n')
                'r' -> sb.append('\r')
                't' -> sb.append('\t')
                'u' -> {
                    val unit = hex4(i + 1)
                    i += 4
                    when {
                        Character.isHighSurrogate(unit) -> {
                            // Must be followed by an escaped low surrogate.
                            if (i + 6 < s.length && s.startsWith("\\u", i + 1)) {
                                val low = hex4(i + 3)
                                if (!Character.isLowSurrogate(low)) fail("lone surrogate escape")
                                sb.append(unit).append(low)
                                i += 6
                            } else {
                                fail("lone surrogate escape")
                            }
                        }
                        Character.isLowSurrogate(unit) -> fail("lone surrogate escape")
                        else -> sb.append(unit)
                    }
                }
                else -> fail("invalid escape")
            }
            i += 1
        }

        private fun hex4(at: Int): Char {
            if (at + 4 > s.length) fail("truncated \\u escape")
            var v = 0
            for (k in 0 until 4) {
                val d = Character.digit(s[at + k], 16)
                if (d < 0) fail("invalid \\u escape")
                v = v * 16 + d
            }
            return v.toChar()
        }
    }
}
