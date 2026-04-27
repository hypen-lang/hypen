pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "hypen-kotlin"

include(":example-server")

// Publishing secrets live in gradle-local.properties (gitignored). They are exported
// as ORG_GRADLE_PROJECT_* env vars by scripts/publish-all.sh before invoking gradle —
// vanniktech's providers.gradleProperty() lookup reads env vars but does not see
// properties injected from this file via gradle.startParameter.setProjectProperties.
