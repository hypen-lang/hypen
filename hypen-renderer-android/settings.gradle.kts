import java.util.Properties

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "hypen-renderer-android"
include(":app")
include(":renderer")

// Load optional local publishing secrets from gradle-local.properties (ignored by git)
val localPropertiesFile = File(rootDir, "gradle-local.properties")
if (localPropertiesFile.exists()) {
    val localProps = Properties().apply {
        load(localPropertiesFile.inputStream())
    }
    gradle.beforeProject {
        localProps.forEach { key, value ->
            if (key is String && value is String && !extensions.extraProperties.has(key)) {
                extensions.extraProperties.set(key, value)
            }
        }
    }
}
