import com.vanniktech.maven.publish.SonatypeHost

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    `java-library`
    id("com.vanniktech.maven.publish") version "0.29.0"
}

group = "space.hypen"
version = "0.4.956"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // JNA for UniFFI native bindings
    implementation("net.java.dev.jna:jna:5.14.0")

    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
}

tasks.withType<Test> {
    useJUnitPlatform()

    // The UniFFI bindings load `libhypen_engine.so/.dylib/.dll` via JNA.
    // The build script for the native library must have run first
    // (`cargo build --release --features uniffi` from the workspace root,
    // or use `../scripts/build-native.sh` if available). Point JNA at
    // the workspace `target/release` directory so the .so is found
    // without requiring the user to set LD_LIBRARY_PATH manually.
    val workspaceTarget = file("${project.rootDir}/../target/release").absolutePath
    systemProperty("jna.library.path", workspaceTarget)
    // JNA also reads `java.library.path` for its fallback search.
    systemProperty(
        "java.library.path",
        listOfNotNull(
            workspaceTarget,
            System.getProperty("java.library.path"),
        ).joinToString(File.pathSeparator),
    )
    environment("LD_LIBRARY_PATH", workspaceTarget)
}

// ---------------------------------------------------------------------------
// Native library bundling
// ---------------------------------------------------------------------------

/**
 * Stage cargo-built native libs under `<jna-arch>/<libname>` inside
 * the JAR's resources. JNA's `Native.load("hypen_engine")` then
 * extracts and loads them at runtime — no `DYLD_LIBRARY_PATH` or
 * external install required for downstream consumers.
 *
 * Each platform's CI job is expected to drop its built library into
 * `native-libs/<jna-arch>/` before `:jar`. Locally, `bundleNativeLib`
 * picks the host's library out of `../target/release` and stages it
 * for `publishToMavenLocal` round-trips.
 */
val nativeLibsDir = layout.buildDirectory.dir("native-libs")

/** Map JVM os/arch tokens onto JNA's resource-prefix convention. */
fun jnaResourcePrefix(): String {
    val osName = System.getProperty("os.name").lowercase()
    val osArch = System.getProperty("os.arch").lowercase()
    val os = when {
        osName.contains("mac") || osName.contains("darwin") -> "darwin"
        osName.contains("linux") -> "linux"
        osName.contains("windows") -> "win32"
        else -> error("Unsupported os: $osName")
    }
    val arch = when (osArch) {
        "aarch64", "arm64" -> "aarch64"
        "x86_64", "amd64" -> "x86-64"
        else -> error("Unsupported arch: $osArch")
    }
    return "$os-$arch"
}

/** Native lib filename for the host (or override via JNA_HOST_PREFIX). */
fun hostLibName(): String {
    val osName = System.getProperty("os.name").lowercase()
    return when {
        osName.contains("mac") || osName.contains("darwin") -> "libhypen_engine.dylib"
        osName.contains("linux") -> "libhypen_engine.so"
        osName.contains("windows") -> "hypen_engine.dll"
        else -> error("Unsupported os: $osName")
    }
}

/**
 * Build the host's native engine library from cargo (release+uniffi)
 * and copy it under `build/native-libs/<jna-arch>/`. Other host
 * platforms in CI append into the same staging dir before `:jar`.
 */
val bundleNativeLib by tasks.registering {
    group = "build"
    description = "Build & stage the host native hypen-engine lib for JAR bundling."

    val workspaceCargo = file("${project.rootDir}/..")
    val targetRelease = file("${project.rootDir}/../target/release")
    val outDir = nativeLibsDir.map { it.dir(jnaResourcePrefix()) }

    inputs.dir(file("${workspaceCargo}/hypen-engine-rs/src"))
    outputs.dir(outDir)

    doLast {
        exec {
            workingDir(file("${workspaceCargo}/hypen-engine-rs"))
            commandLine("cargo", "build", "--release", "--features", "uniffi")
        }
        val src = file("${targetRelease}/${hostLibName()}")
        if (!src.exists()) error("cargo did not produce ${src.path}")
        val dst = outDir.get().asFile.also { it.mkdirs() }
        src.copyTo(file("${dst}/${hostLibName()}"), overwrite = true)
        logger.lifecycle("Staged ${dst}/${hostLibName()}")
    }
}

sourceSets {
    main {
        resources {
            // Anything under `build/native-libs/` (populated by the host
            // job + per-platform CI jobs) ends up at `<arch>/<libname>`
            // inside the published JAR.
            srcDir(nativeLibsDir)
        }
    }
}

// Make sure host-built libs are present before any artifact that walks
// the resources tree (jar, sourcesJar, processResources) is assembled.
tasks.named("processResources") { dependsOn(bundleNativeLib) }
tasks.matching { it.name == "sourcesJar" }.configureEach { dependsOn(bundleNativeLib) }
tasks.matching { it.name == "javadocJar" }.configureEach { dependsOn(bundleNativeLib) }

kotlin {
    jvmToolchain(17)
}

mavenPublishing {
    coordinates("space.hypen", "hypen-kotlin", project.version.toString())
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    signAllPublications()

    pom {
        name.set("Hypen Kotlin SDK")
        description.set("Kotlin/JVM SDK for building Hypen server-driven applications.")
        url.set("https://github.com/hypen-lang/hypen")

        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/licenses/MIT")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("hypen")
                name.set("Hypen")
                url.set("https://hypen.space")
            }
        }
        scm {
            url.set("https://github.com/hypen-lang/hypen")
            connection.set("scm:git:git://github.com/hypen-lang/hypen.git")
            developerConnection.set("scm:git:ssh://git@github.com:hypen-lang/hypen.git")
        }
    }
}

// Exclude example-server from default build — build it explicitly with:
//   ./gradlew :example-server:build
//   ./gradlew :example-server:run
gradle.taskGraph.whenReady {
    allTasks
        .filter { it.project.name == "example-server" }
        .forEach { task ->
            val requested = gradle.startParameter.taskRequests.flatMap { it.args }
            if (requested.none { it.contains("example-server") }) {
                task.enabled = false
            }
        }
}
