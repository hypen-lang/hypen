package space.hypen.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cross-SDK compatibility runner for the engine's portable helpers
 * (diff_paths, match_path, session_step, path_*, url helpers).
 *
 * Each JSON fixture under
 * `engine-compatibility-tests/fixtures/portable/` is fed through the
 * UniFFI-generated Kotlin bindings to the Rust engine. Passing proves
 * the Kotlin host routes through the same canonical implementation as
 * every other SDK.
 */
class PortableCompatibilityTest {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }

    @TestFactory
    fun runPortableFixtures(): Collection<DynamicTest> {
        val root = File("../engine-compatibility-tests/fixtures/portable")
        check(root.exists()) { "portable fixtures dir missing: ${root.absolutePath}" }

        return root.walkTopDown()
            .filter { it.isFile && it.extension == "json" }
            .sortedBy { it.name }
            .map { file ->
                DynamicTest.dynamicTest(file.nameWithoutExtension) {
                    runFixture(file)
                }
            }
            .toList()
    }

    private fun runFixture(file: File) {
        val root = json.parseToJsonElement(file.readText()).jsonObject
        val fn = root["function"]!!.jsonPrimitive.content
        val input = root["input"] ?: error("fixture missing 'input' field: ${file.name}")
        val expected = root["expected"] ?: error("fixture missing 'expected' field: ${file.name}")

        when (fn) {
            "diff_paths" -> runDiff(input.jsonObject, expected)
            "match_path" -> runRoute(input.jsonObject, expected)
            "session_step" -> runSession(input.jsonObject, expected)
            "path_get" -> runPathGet(input.jsonObject, expected)
            "path_has" -> runPathHas(input.jsonObject, expected)
            "path_set" -> runPathSet(input.jsonObject, expected)
            "path_delete" -> runPathDelete(input.jsonObject, expected)
            "encode_uri_component" -> runEncode(input.jsonPrimitive.content, expected)
            "decode_uri_component" -> runDecode(input.jsonPrimitive.content, expected)
            "parse_query" -> runParseQuery(input.jsonPrimitive.content, expected)
            "build_url" -> runBuildUrl(input.jsonObject, expected)
            else -> error("unknown portable function: $fn")
        }
    }

    private fun runDiff(input: JsonObject, expected: JsonElement) {
        val oldJson = input["old"]!!.toString()
        val newJson = input["new"]!!.toString()
        val rawGot = uniffi.hypen_engine.portableDiffPaths(oldJson, newJson)
        val got = json.parseToJsonElement(rawGot) as JsonArray
        val want = expected as JsonArray
        val gotSorted = got.sortedBy { (it as JsonObject)["path"]!!.jsonPrimitive.content }
        val wantSorted = want.sortedBy { (it as JsonObject)["path"]!!.jsonPrimitive.content }
        assertEquals(wantSorted, gotSorted, "fixture mismatch (diff_paths)")
    }

    private fun runRoute(input: JsonObject, expected: JsonElement) {
        val pattern = input["pattern"]!!.jsonPrimitive.content
        val path = input["path"]!!.jsonPrimitive.content
        val rawGot = uniffi.hypen_engine.portableMatchPath(pattern, path)
        val got = json.parseToJsonElement(rawGot).jsonObject
        val want = expected.jsonObject
        assertEquals(
            want["matched"]!!.jsonPrimitive.boolean,
            got["matched"]!!.jsonPrimitive.boolean,
            "matched field"
        )
        assertEquals(
            (want["params"] ?: JsonObject(emptyMap())).jsonObject,
            (got["params"] ?: JsonObject(emptyMap())).jsonObject,
            "params field"
        )
    }

    private fun runSession(input: JsonObject, expected: JsonElement) {
        val stateJson = input["state"]!!.toString()
        val eventJson = input["event"]!!.toString()
        val rawGot = uniffi.hypen_engine.portableSessionStep(stateJson, eventJson)
        val got = json.parseToJsonElement(rawGot).jsonObject
        val want = expected.jsonObject
        assertEquals(
            want["kind"]!!.jsonPrimitive.content,
            got["kind"]!!.jsonPrimitive.content,
            "effect kind"
        )
    }

    private fun runPathGet(input: JsonObject, expected: JsonElement) {
        val valueJson = input["value"]!!.toString()
        val path = input["path"]!!.jsonPrimitive.content
        val rawGot = uniffi.hypen_engine.portablePathGet(valueJson, path)
        val got = json.parseToJsonElement(rawGot)
        assertEquals(expected, got, "path_get value")
    }

    private fun runPathHas(input: JsonObject, expected: JsonElement) {
        val valueJson = input["value"]!!.toString()
        val path = input["path"]!!.jsonPrimitive.content
        val rawGot = uniffi.hypen_engine.portablePathHas(valueJson, path)
        val got = (json.parseToJsonElement(rawGot) as JsonPrimitive).boolean
        assertEquals(expected.jsonPrimitive.boolean, got, "path_has")
    }

    private fun runPathSet(input: JsonObject, expected: JsonElement) {
        val valueJson = input["value"]!!.toString()
        val path = input["path"]!!.jsonPrimitive.content
        val newValueJson = input["new_value"]!!.toString()
        val rawGot = uniffi.hypen_engine.portablePathSet(valueJson, path, newValueJson)
        val got = json.parseToJsonElement(rawGot)
        assertEquals(expected, got, "path_set result")
    }

    private fun runPathDelete(input: JsonObject, expected: JsonElement) {
        val valueJson = input["value"]!!.toString()
        val path = input["path"]!!.jsonPrimitive.content
        val rawGot = uniffi.hypen_engine.portablePathDelete(valueJson, path)
        val got = json.parseToJsonElement(rawGot)
        assertEquals(expected, got, "path_delete result")
    }

    private fun runEncode(input: String, expected: JsonElement) {
        val got = uniffi.hypen_engine.portableEncodeUriComponent(input)
        assertEquals(expected.jsonPrimitive.content, got, "encode_uri_component")
    }

    private fun runDecode(input: String, expected: JsonElement) {
        val got = uniffi.hypen_engine.portableDecodeUriComponent(input)
        assertEquals(expected.jsonPrimitive.content, got, "decode_uri_component")
    }

    private fun runParseQuery(input: String, expected: JsonElement) {
        val rawGot = uniffi.hypen_engine.portableParseQuery(input)
        val got = json.parseToJsonElement(rawGot)
        assertEquals(expected, got, "parse_query result")
    }

    private fun runBuildUrl(input: JsonObject, expected: JsonElement) {
        val path = input["path"]!!.jsonPrimitive.content
        val queryJson = input["query"]!!.toString()
        val got = uniffi.hypen_engine.portableBuildUrl(path, queryJson)
        assertEquals(expected.jsonPrimitive.content, got, "build_url")
    }
}
