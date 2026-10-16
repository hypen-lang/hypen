import com.vanniktech.maven.publish.SonatypeHost

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.maven.publish)
}

// Robolectric runtime for the Compose UI unit tests (see testOptions). The
// version must match the SDK the tests run on (src/test/resources/
// robolectric.properties: sdk=34) for the Robolectric version in
// libs.versions.toml: 4.14.1 maps API 34 to 14-robolectric-10818077, and its
// pre-instrumented jars carry the -i7 suffix. It also reads resources from
// its newest supported SDK's jar (API 35, 15-robolectric-12650502), so that
// one is needed too.
val robolectricAndroidAll: Configuration by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}
val robolectricAndroidAllDir = layout.buildDirectory.dir("robolectric-android-all")
val copyRobolectricAndroidAll = tasks.register<Copy>("copyRobolectricAndroidAll") {
    from(robolectricAndroidAll)
    into(robolectricAndroidAllDir)
}

android {
    namespace = "space.hypen.renderer"
    compileSdk = 36

    defaultConfig {
        minSdk = 24

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = "11"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        // Compose UI tests (createComposeRule) run on Robolectric and need the
        // merged manifest (ui-test-manifest's ComponentActivity) and resources.
        unitTests.isIncludeAndroidResources = true
        unitTests.all { test ->
            // Robolectric's android-all jar comes through Gradle (the build's
            // own repositories and cache) instead of Robolectric's built-in
            // Maven Central fetcher, so it runs offline and behind mirrors.
            test.dependsOn(copyRobolectricAndroidAll)
            test.systemProperty("robolectric.offline", "true")
            test.systemProperty("robolectric.dependency.dir", robolectricAndroidAllDir.get().asFile.absolutePath)
            test.systemProperty("robolectric.logging.enabled", "false")
        }
    }

    packaging {
        // Instrumentation dependencies carry duplicate JUnit notices.
        resources.merges += setOf("META-INF/LICENSE.md", "META-INF/LICENSE-notice.md", "META-INF/NOTICE.md")
    }
}

dependencies {
    // Android Core
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)

    // Compose
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui.text.google.fonts)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // OkHttp for WebSocket
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    // Moshi for JSON parsing
    implementation(libs.moshi)
    implementation(libs.moshi.kotlin)
    implementation(libs.moshi.adapters)

    // Coroutines
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    // Image Loading
    implementation(libs.coil.compose)

    // Media3 (ExoPlayer) for Video. The HLS module must be on the classpath
    // for `.m3u8` sources to play — DefaultMediaSourceFactory discovers it
    // reflectively at runtime (capability matrix in
    // hypen-web/docs/components/video.md claims Android HLS support).
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)

    // Unit Testing
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockk)
    testImplementation(libs.okhttp.mockwebserver)

    // Compose UI tests on the JVM (Robolectric)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    robolectricAndroidAll("org.robolectric:android-all-instrumented:14-robolectric-10818077-i7")
    robolectricAndroidAll("org.robolectric:android-all-instrumented:15-robolectric-12650502-i7")

    // Android Testing
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.mockk.android)
}

mavenPublishing {
    coordinates("space.hypen", "hypen-renderer", project.version.toString())
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    signAllPublications()

    pom {
        name.set("Hypen Compose Renderer")
        description.set("Jetpack Compose renderer for Hypen server-driven UIs.")
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
            connection.set("scm:git:https://github.com/hypen-lang/hypen.git")
            developerConnection.set("scm:git:ssh://git@github.com/hypen-lang/hypen.git")
        }
    }
}
