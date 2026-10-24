plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
}

group = "space.hypen.examples"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    // Published SDK; the jar bundles the native engine for Linux, macOS and
    // Windows. settings.gradle.kts swaps in ../../../hypen-kotlin when
    // HYPEN_KOTLIN_SDK is set (contributors).
    implementation("space.hypen:hypen-kotlin:0.6.7")
    implementation("io.ktor:ktor-server-core:3.1.1")
    implementation("io.ktor:ktor-server-netty:3.1.1")
    implementation("io.ktor:ktor-server-websockets:3.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.xerial:sqlite-jdbc:3.45.1.0")
}

kotlin {
    jvmToolchain(17)
}

// Native engine: the published SDK bundles it, so nothing is needed by
// default. HYPEN_NATIVE_LIB_DIR loads a locally built one instead; when the
// SDK is built from source (HYPEN_KOTLIN_SDK, which bundles no engine) the
// workspace target/release or target/debug is used (build it with
// `cargo build --release -p hypen-engine --features uniffi`).
val engineLibDir: String? = System.getenv("HYPEN_NATIVE_LIB_DIR")?.let { file(it).canonicalPath }
    ?: System.getenv("HYPEN_KOTLIN_SDK")?.let {
        (listOf("release", "debug").map { file("../../../target/$it") }
            .firstOrNull { dir -> dir.listFiles()?.any { it.name.contains("hypen_engine") } == true }
            ?: file("../../../target/release")).canonicalPath
    }

application {
    mainClass.set("space.hypen.instagram.MainKt")
    if (engineLibDir != null) applicationDefaultJvmArgs = listOf("-Djna.library.path=$engineLibDir")
}
