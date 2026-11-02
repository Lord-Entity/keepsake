# Disposable Android build image for Keepsake (Tauri 2). Remove with: docker rmi keepsake-android
#
# Every tool is pinned. Keep these values in sync with .github/workflows/build.yml (android job).
#   Base image   ubuntu:24.04 (for full reproducibility, pin by digest: ubuntu:24.04@sha256:<digest>)
#   JDK          17 (openjdk-17-jdk-headless; the Android Gradle Plugin used by Tauri 2 needs JDK 17)
#   Android      platform android-37.0, build-tools 37.0.0 (Tauri CLI 2.12 writes compileSdk/targetSdk 37)
#   NDK          27.2.12479018
#   rustup-init  1.29.3 (sha256 from rust-lang/docker-rust), toolchain Rust 1.90.0
#   Bun          1.4.4 (sha256 from the release SHASUMS256.txt)
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG CMDLINE_TOOLS_REV=13114758
ARG NDK_VERSION=27.2.12479018
ARG BUILD_TOOLS=37.0.0
ARG PLATFORM=android-37.0
ARG RUST_VERSION=1.90.0
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c

# System packages + JDK 17 + build essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip git rsync xz-utils perl \
      build-essential pkg-config libssl-dev clang lld \
      openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV NDK_HOME=/opt/android-sdk/ndk/${NDK_VERSION}
ENV ANDROID_NDK_HOME=/opt/android-sdk/ndk/${NDK_VERSION}
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/cargo/bin:/opt/bun/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/${BUILD_TOOLS}:${PATH}

# Android SDK (cmdline-tools, platform, build-tools, NDK).
# Note: Google publishes the cmdline-tools checksum only in its repository XML, so the zip is
# not checksum-verified here; sdkmanager verifies every package it installs itself.
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -fsSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_REV}_latest.zip \
    && unzip -q /tmp/clt.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/clt.zip \
    && (yes | sdkmanager --licenses >/dev/null || true) \
    && sdkmanager "platform-tools" "platforms;${PLATFORM}" "build-tools;${BUILD_TOOLS}" "ndk;${NDK_VERSION}"

# Rust: pinned, checksum-verified rustup-init (no curl | sh), pinned toolchain.
# Only the arm64 Android target is installed; build.sh adds the others when ALL_ABIS=1.
RUN curl -fsSL -o /tmp/rustup-init \
      https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain ${RUST_VERSION} \
    && rm /tmp/rustup-init \
    && rustup target add aarch64-linux-android \
    && rustc --version

# bun (checksum-verified)
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp && mkdir -p /opt/bun/bin \
    && mv /tmp/bun-linux-x64/bun /opt/bun/bin/bun && rm -rf /tmp/bun* \
    && bun --version

COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/build.sh"]
