import com.vanniktech.maven.publish.SonatypeHost

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    `java-library`
    id("com.vanniktech.maven.publish") version "0.29.0"
}

group = "space.hypen"
version = "0.6.5"

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
    // A real WebSocket server for the cross-language device e2e test
    // (`deviceE2eTest`): Netty's HTTP/WebSocket codec, test scope only —
    // the SDK itself stays transport-agnostic (HypenTransport).
    testImplementation("io.netty:netty-codec-http:4.1.110.Final")
}

tasks.withType<Test> {
    useJUnitPlatform()

    // The UniFFI bindings load `libhypen_engine.so/.dylib/.dll` via JNA.
    // The build script for the native library must have run first
    // (`cargo build --release --features uniffi` from the workspace root,
    // or use `../scripts/build-native.sh` if available). Point JNA at
    // the workspace `target/release` directory so the .so is found
    // without requiring the user to set LD_LIBRARY_PATH manually.
    //
    // A STALE library fails confusingly, not obviously: the generated
    // `Patch` record is read POSITIONALLY, so a library built before a
    // field was added to it writes fewer fields than the bindings read.
    // The first patch absorbs the mismatch, then the sequence read is
    // misaligned and the NEXT patch's type lands on garbage —
    // surfacing as `RuntimeException: invalid enum value, something is
    // very wrong!!` from `FfiConverterTypePatchType.read`, in a handful
    // of multi-patch tests while simpler ones still pass. If you see
    // that, rebuild the native library before debugging anything else.
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

// The default suite excludes the cross-language e2e test (it needs bun and
// hypen-web's node_modules); run it explicitly:
//   ./gradlew deviceE2eTest --offline
tasks.named<Test>("test") {
    useJUnitPlatform {
        excludeTags("e2e")
    }
}

val deviceE2eTest by tasks.registering(Test::class) {
    description = "Device plane e2e: the TypeScript web client (bun) against HypenServer over a real WebSocket."
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    useJUnitPlatform {
        includeTags("e2e")
    }
    outputs.upToDateWhen { false }
    testLogging {
        events("passed", "failed")
        showStandardStreams = true
    }
}

tasks.register<JavaExec>("deviceLab") {
    dependsOn("testClasses")
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("space.hypen.core.DeviceLab")
    systemProperty("jna.library.path", file("../target/release").absolutePath)
}

// JVM toolchain. The default is 17 (the published bytecode level). When a JDK
// 17 is installed Gradle uses it as a toolchain exactly as before. When it is
// NOT installed (no auto-provisioning is configured) and the JVM running
// Gradle is 17 or newer, the build falls back to that JVM while still
// emitting 17 bytecode (`-jvm-target 17` / `--release 17`), so the plain
// `./gradlew test` definition-of-done command works on a JDK-21-only
// machine. `-Phypen.jvmToolchain=<n>` still overrides the requested level.
val hypenJvmVersion: Int = (findProperty("hypen.jvmToolchain") as String?)?.toIntOrNull() ?: 17
val hypenJvmInstalled: Boolean = runCatching {
    javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(hypenJvmVersion)) }.get()
}.isSuccess
val runningJvmVersion: Int = JavaVersion.current().majorVersion.toInt()

if (hypenJvmInstalled || runningJvmVersion < hypenJvmVersion) {
    kotlin {
        jvmToolchain(hypenJvmVersion)
    }
} else {
    logger.lifecycle(
        "hypen-kotlin: no JDK $hypenJvmVersion installed; compiling with the running JDK $runningJvmVersion " +
            "targeting $hypenJvmVersion bytecode (install JDK $hypenJvmVersion or pass -Phypen.jvmToolchain=$runningJvmVersion to silence)",
    )
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(hypenJvmVersion.toString()))
        }
    }
    java {
        sourceCompatibility = JavaVersion.toVersion(hypenJvmVersion)
        targetCompatibility = JavaVersion.toVersion(hypenJvmVersion)
    }
    tasks.withType<JavaCompile>().configureEach {
        options.release.set(hypenJvmVersion)
    }
}

mavenPublishing {
    coordinates("space.hypen", "hypen-kotlin", project.version.toString())
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    signAllPublications()

    pom {
        name.set("Hypen Kotlin SDK")
        description.set("Kotlin/JVM SDK for building Hypen server-driven applications.")
        url.set("https://github.com/hypenlang/hypen-rs")

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
            url.set("https://github.com/hypenlang/hypen-rs")
            connection.set("scm:git:git://github.com/hypenlang/hypen-rs.git")
            developerConnection.set("scm:git:ssh://git@github.com:hypenlang/hypen-rs.git")
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
