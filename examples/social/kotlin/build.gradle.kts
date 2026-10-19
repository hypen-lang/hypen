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
    implementation("space.hypen:hypen-kotlin:0.1.0")
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

// Resolve the native engine library (built in hypen-engine-rs with
// `cargo build --release --features uniffi`, or without --release): prefer
// target/release, fall back to target/debug. HYPEN_NATIVE_LIB_DIR overrides.
val engineLibDir = (System.getenv("HYPEN_NATIVE_LIB_DIR")?.let { file(it) }
    ?: listOf("release", "debug").map { file("../../../target/$it") }
        .firstOrNull { dir -> dir.listFiles()?.any { it.name.contains("hypen_engine") } == true }
    ?: file("../../../target/release")).canonicalPath

application {
    mainClass.set("space.hypen.instagram.MainKt")
    applicationDefaultJvmArgs = listOf("-Djna.library.path=$engineLibDir")
}

tasks.named<JavaExec>("run") {
    jvmArgs("-Djna.library.path=$engineLibDir")
}
