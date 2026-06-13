import com.vanniktech.maven.publish.SonatypeHost

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    `java-library`
    id("com.vanniktech.maven.publish") version "0.29.0"
}

group = "space.hypen"
version = "0.5.0"

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
