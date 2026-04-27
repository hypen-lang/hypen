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

// Publishing secrets live in gradle-local.properties (gitignored). They are exported
// as ORG_GRADLE_PROJECT_* env vars by scripts/publish-all.sh before invoking gradle —
// vanniktech's providers.gradleProperty() lookup reads env vars but does not see
// properties injected from this file via gradle.startParameter.setProjectProperties.
