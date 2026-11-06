import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python") // version comes from the root buildscript classpath (scripts/android-patch-gradle.sh)
}

android {
    namespace = "app.keepsake.media"
    // Same as the Tauri CLI 2.12.4 plugin/app templates; CI and Docker install only platforms;android-37.0.
    compileSdk = 37

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        // Chaquopy needs explicit ABIs; Python 3.12 builds are 64-bit only.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

chaquopy {
    defaultConfig {
        version = "3.12"
        pip {
            install("yt-dlp==2026.10.26")
            install("certifi==2026.10.23")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    // Same versions the official Tauri plugins use; Plugin's API surface references androidx types.
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation(project(":tauri-android"))
}
