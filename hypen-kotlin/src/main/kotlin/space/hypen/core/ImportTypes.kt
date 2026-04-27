package space.hypen.core

/**
 * Represents parsed import information from a Hypen document.
 * Returned by NativeEngine.getPendingImports() after rendering.
 */
data class ImportStatement(
    /** Component names being imported (e.g., ["Button", "Card"]) */
    val names: List<String>,
    /** Source path (e.g., "./components/ui" or "https://cdn.example.com/ui") */
    val sourcePath: String,
    /** Source type: "local" or "url" */
    val sourceType: String
) {
    val isLocal: Boolean get() = sourceType == "local"
    val isUrl: Boolean get() = sourceType == "url"
}

/**
 * Represents a resolved component definition with its template source.
 */
data class ComponentDefinition(
    /** The Hypen DSL template source */
    val template: String,
    /** The resolved file path */
    val path: String = ""
)
