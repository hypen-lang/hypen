rootProject.name = "hypen-instagram-kotlin"

// For contributors: build space.hypen:hypen-kotlin from this checkout instead
// of Maven Central (export HYPEN_KOTLIN_SDK=1, or a path to another checkout).
System.getenv("HYPEN_KOTLIN_SDK")?.let { sdk ->
    includeBuild(if (sdk == "1" || sdk == "true") "../../../hypen-kotlin" else sdk)
}
