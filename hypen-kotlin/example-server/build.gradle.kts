plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("io.ktor.plugin") version "3.1.1"
}

group = "space.hypen"
version = "0.0.1"

application {
    mainClass = "io.ktor.server.netty.EngineMain"
}

// Mirrors the root build: JDK 17 toolchain when installed, otherwise the
// running JDK (>= 17) emitting 17 bytecode; `-Phypen.jvmToolchain=<n>` overrides.
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

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":"))

    implementation("io.ktor:ktor-server-core")
    implementation("io.ktor:ktor-server-content-negotiation")
    implementation("io.ktor:ktor-serialization-kotlinx-json")
    implementation("io.ktor:ktor-server-websockets")
    implementation("io.ktor:ktor-server-netty")
    implementation("ch.qos.logback:logback-classic:1.4.14")
    implementation("io.ktor:ktor-server-config-yaml")
    testImplementation("io.ktor:ktor-server-test-host")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
