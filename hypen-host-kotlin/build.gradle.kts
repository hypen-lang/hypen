plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    `java-library`
}

group = "space.hypen"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // JNA for the UniFFI native bindings.
    implementation("net.java.dev.jna:jna:5.14.0")

    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
}

kotlin {
    jvmToolchain(21)
}

tasks.withType<Test> {
    useJUnitPlatform()

    // The UniFFI bindings load `libhypen_engine.so/.dylib/.dll` via JNA.
    // Build it first from the workspace root:
    //   cargo build --release --features "uniffi,module-loader"
    // Tests search release first, then debug, so a dev loop that only ran a
    // debug build still works.
    val release = file("${project.rootDir}/../target/release").absolutePath
    val debug = file("${project.rootDir}/../target/debug").absolutePath
    val searchPath = listOf(release, debug).joinToString(File.pathSeparator)
    systemProperty("jna.library.path", searchPath)
    systemProperty("java.library.path", searchPath)
}
