<div align="center">

<img src="src/assets/logo.png" alt="Keepsake logo" width="128" height="128">

# Keepsake

**Downloads with a memory.**

A video, audio and thumbnail downloader for Windows, Linux and Android, built from one codebase.

[![Release](https://img.shields.io/badge/release-v2.1.0-blue)](#install)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20Android-informational)](#platforms)
[![CI](https://img.shields.io/github/actions/workflow/status/OWNER/REPO/build.yml?label=build)](.github/workflows/build.yml)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](#license)

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Rust](https://img.shields.io/badge/Rust-1.90%2B-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [Screens](#screens)
- [Editor](#editor)
- [Platforms](#platforms)
- [Supported sites](#supported-sites)
- [Install](#install)
- [Build from source](#build-from-source)
- [Releasing](#releasing)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Credits](#credits)
- [Legal](#legal)
- [Contributing](#contributing)
- [License](#license)

## Overview

Paste a link, preview it, pick a format (a video quality, an audio format and bitrate, or the thumbnail) and download it. Finished downloads are kept in a searchable Library, so you can find and reopen them later.

Keepsake is a [Tauri 2](https://v2.tauri.app) app. The interface is React 19 with Tailwind CSS 4, and all extraction, download and conversion logic is TypeScript in [`src/engine`](src/engine). The Rust code in [`src-tauri`](src-tauri) is a thin shell: it registers plugins, shows the window and launches the bundled yt-dlp on desktop.

## Features

- **Video, audio or thumbnail.** One format picker with three modes:
  - **Video:** Best, or a specific height (for example 1080p60), with an optional "Prefer H.264" switch for maximum compatibility.
  - **Audio:** MP3, M4A, OPUS, WAV or FLAC on desktop; M4A or WAV on Android (M4A only for TikTok and Instagram). MP3 offers 128, 192, 256 or 320 kbps. M4A is the original AAC stream with no conversion; WAV and FLAC are lossless copies of the source.
  - **Thumbnail:** original format, PNG or JPG.
- **Link preview.** Title, channel, duration and thumbnail before you download, plus an Advanced table of the raw streams (desktop).
- **Playlists** on desktop, with per-item progress.
- **Download queue** with 1 to 10 parallel downloads, live speed, ETA and cancel.
- **Library** of finished, failed and cancelled downloads, with search (title, channel or site), filters by kind and status, and sorting by newest, oldest or title.
- **Cover art and metadata** embedded into the file (desktop, optional): on by default for audio, off by default for video, because every embed pass rewrites the whole video file.
- **Clipboard detection** that offers a copied link when the app gets focus (optional).
- **Cookies from your browser** for age-gated, private or members-only content you can already view (desktop, optional).
- **In-app notifications** when a download finishes or fails, with friendly error messages and a "Show details" disclosure.
- **Dark and light themes**, or follow the system setting.
- **Keyboard shortcuts** for every page and the main actions.
- **Responsive layout:** sidebar on desktop, bottom tab bar on phones.
- **Android back button:** closes the open dialog or sheet first, then returns to Home; on Home it shows "Press back again to exit", and a second press within 2 seconds leaves the app (on Android 12 and newer, Android moves the app to the background rather than closing it).

## Screens

| Page | What it does |
|---|---|
| **Home** | Paste a link, see the preview, choose a format and start the download. Also shows active downloads, recent activity and the save folder. |
| **Downloads** | The queue: every running and finished job with progress, speed and ETA. Filter by All, Active, Done or Failed, cancel jobs, or clear finished ones. |
| **Library** | Everything you have downloaded. Search, filter by kind (video, audio, thumbnail) and status, sort, and open a file or its folder. |
| **Settings** | Save folder, parallel downloads, cookies, thumbnail embedding, H.264 preference, clipboard detection, theme, and the installed yt-dlp, ffmpeg and JavaScript runtime versions. |

## Editor

The **Editor** tab makes quick edits to a photo or video on your device. It does not add filters, text or effects.

- **Crop** freely or to a fixed ratio (Original, 1:1, 4:5, 9:16, 16:9, 4:3, 3:4), with zoom and pan in the preview.
- **Trim** a video's start and end.
- **Mute** a video (drop its audio).
- **Export** photos as JPG or PNG, and videos as MP4. The edit is saved as `<name>_edit.<ext>`; the original file is never changed.

| | How it works |
|---|---|
| Photos (all platforms) | Cropped and encoded inside the app (canvas), so no extra tools are needed. EXIF rotation is applied first. |
| Video on Windows / Linux | The bundled ffmpeg trims and mutes by stream copy, so a trim starts at the nearest earlier keyframe. The bundled minimal LGPL ffmpeg has no video encoder, so **cropping runs inside the app with nothing to install**: the web engine decodes, crops and re-encodes to H.264 with WebCodecs (usually faster than real time), or, where WebCodecs has no H.264 encoder, records the cropped clip in real time; ffmpeg then copies the result into the final MP4. The fast path reads the clip into memory, so it is limited to about 768 MB of source up to the trim end. Windows N editions need the Media Feature Pack, and Linux needs the GStreamer H.264 plugins for in-app cropping; without them, trim and mute still work. A full ffmpeg on your PATH (libx264 or a hardware H.264 encoder) is used first when present and also makes trims frame-accurate. The Editor shows which of these your setup supports. See [docs/EDITOR_DESKTOP_ENCODER.md](docs/EDITOR_DESKTOP_ENCODER.md). |
| Video on Android | AndroidX Media3 Transformer in the native `keepsake-media` plugin re-encodes to H.264/AAC MP4 with the phone's hardware codecs. Crop and trim are frame-accurate. The result is saved the same way as downloads (Gallery, your chosen folder, or the save folder). |

Audio-only files (M4A, MP3 and so on) cannot be edited; the Editor accepts photos and videos only.

Developer notes: [`src/editor/CONTRACT.md`](src/editor/CONTRACT.md).

## Platforms

| Platform | Packages | Expected size (estimate) | How downloads work |
|---|---|---|---|
| Windows 10 / 11 (x64) | NSIS `.exe` installer only | about 25-35 MB | Bundled yt-dlp, a minimal LGPL ffmpeg for merging and conversion, and QuickJS for YouTube |
| Linux (x64) | `.deb`, `.rpm`, `.AppImage` | `.deb` / `.rpm` about 20-40 MB; `.AppImage` likely 100 MB or more (it bundles WebKitGTK) | Same bundled standalone yt-dlp, ffmpeg and QuickJS in every package; no system Python needed |
| Android 7.0+ (API 24) | arm64 `.apk` (default build) | about 35-50 MB (includes Python, yt-dlp, QuickJS-NG and a minimal ffmpeg) | YouTube through the bundled yt-dlp with its own JavaScript runtime (QuickJS-NG) and a minimal LGPL ffmpeg, like desktop; falls back to youtubei.js plus a PO token if that route is not ready. TikTok and Instagram through the bundled yt-dlp (Chaquopy, arm64 only, separate streams combined natively, M4A audio only, no MP3); audio conversion through the native `keepsake-media` plugin |

The sizes are estimates from the component sizes, not measurements of a release build. They will be replaced with measured numbers once CI publishes the artifacts. Each CI job writes its artifact sizes to the job summary.

## Supported sites

| | Desktop (Windows, Linux) | Android |
|---|---|---|
| YouTube | Yes, all qualities | Yes, every quality the video offers, through the bundled yt-dlp (see below); if that route is not ready, youtubei.js with a PO token, and 360p when no token can be minted |
| Audio formats | MP3, M4A, OPUS, WAV, FLAC | M4A (default) and WAV |
| TikTok, Instagram | Yes | Yes, through the bundled yt-dlp (public posts, single videos; separate video and audio streams are combined on the phone without re-encoding; M4A audio only) |
| Other sites | 1,000+ sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) | No |
| Playlists | Yes | No |
| DRM-protected content | No | No |

On Android, TikTok and Instagram links download through the yt-dlp that is bundled in the app (arm64 only). They offer the heights the site serves. When video and audio come as separate streams, both are downloaded and combined on the phone without re-encoding. Audio is M4A only; there is no MP3, and login-only posts fail.

**YouTube on Android: self-contained yt-dlp (new, not yet confirmed on a device).** The APK bundles the same helpers the desktop app uses: [QuickJS-NG](https://github.com/quickjs-ng/quickjs) (a small JavaScript runtime) with yt-dlp's EJS challenge solver, and a minimal LGPL ffmpeg. yt-dlp then solves YouTube's challenges on the phone, uses its default clients (which need no PO token, as on desktop), and downloads and merges every height the video offers into MP4 (or MKV when the streams do not fit MP4). The route is used only when the app's self-check (`ytdlp_status`) reports `ready`; Settings > Components > **Copy diagnostics** shows the yt-dlp, EJS, QuickJS-NG and ffmpeg versions. Any error on it falls back once to the youtubei.js path described next. In this first version only YouTube uses the route; TikTok and Instagram work as described above. How it works and how to test it on a phone: [docs/ANDROID_SELFCONTAINED.md](docs/ANDROID_SELFCONTAINED.md).

**Fallback:** YouTube on Android uses youtubei.js and mints a **PO token** on the phone: Google's BotGuard runs in the app's own WebView, so higher qualities unlock without Node, Deno or a second app. Links accepted are `youtube.com`, `www.`, `m.` and `music.youtube.com` `/watch?v=`, `youtu.be/ID`, and `/shorts/`, `/live/` and `/embed/` paths (https only). Only the 11-character video ID is used; playlist-only links are rejected, single videos only. The best video-only stream at the chosen height is paired with its matching audio-only stream and combined on the phone without re-encoding: **MP4** for AVC/HEVC + AAC, **WebM** for VP8/VP9 + Vorbis/Opus, and AV1 into MP4 on Android 10 or newer. That reaches 1440p and 4K where the video offers them. If the token cannot be minted (offline, blocked challenge, future BotGuard change) or the link has no adaptive pair, Keepsake falls back to the 360p MP4 it used before. Settings > Components > **Copy diagnostics** reports whether the PO token was minted. Audio is saved as M4A without conversion or decoded to WAV on the phone. MP3, FLAC and OPUS are not offered on Android yet, because Android has no built-in MP3 encoder and the FLAC and Opus encoders are not available on every supported Android version.

DRM-protected streams (most paid streaming services) cannot be downloaded on any platform.

## Install

Download the latest installer for your platform from the **Releases** page of this repository.

| Platform | File | Notes |
|---|---|---|
| Windows | `Keepsake_<version>_x64-setup.exe` (NSIS) | Installs for the current user, no admin rights needed. There is no `.msi` |
| Linux | `.deb` (Debian, Ubuntu) / `.rpm` (Fedora, openSUSE) | Installs system-wide |
| Linux | `.AppImage` | Self-contained. `chmod +x` it and run |
| Android | arm64 `.apk` | For 64-bit ARM phones (almost every phone since 2017). Sideload; see below |

The exact file names come from the Tauri bundler and may differ slightly.

**Builds are not code-signed yet.**

- **Windows:** SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **Android:** allow **Install unknown apps** for your browser or file manager when Android asks. CI builds a debug-signed APK; a newer build may refuse to install over an older one ("App not installed"). Uninstall the old one first, and note that uninstalling deletes files in the app's private folder.

**Nothing else to install on desktop.** yt-dlp needs a JavaScript runtime to solve YouTube's challenges. Keepsake bundles one, [QuickJS-NG](https://github.com/quickjs-ng/quickjs), and passes it to yt-dlp. If the bundled copy is missing, Keepsake falls back to a Node.js you have installed yourself; if neither is found, YouTube downloads fail with a message saying so. Windows also needs WebView2, which Windows 10 and 11 already include (the installer downloads it if missing).

## Build from source

### Prerequisites

All platforms:

- [Rust](https://rustup.rs) **1.90.0** (the minimum `src-tauri/Cargo.toml` declares, and the version CI pins; `tauri-plugin-http` 2.8 and `tauri-plugin-fs` 2.7 require it). Newer stable releases should also work.
- [Bun](https://bun.sh) **1.4.x** (CI and the Android Docker image use 1.4.4)
- Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

<details>
<summary><b>Windows</b></summary>

- **Visual Studio Build Tools** with the "Desktop development with C++" workload (MSVC linker and Windows SDK).
- Rust with the MSVC toolchain (`stable-x86_64-pc-windows-msvc`), which is the rustup default on Windows.
- WebView2 (included in Windows 10 and 11).

</details>

<details>
<summary><b>Linux (Debian / Ubuntu)</b></summary>

The same packages CI installs:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf xz-utils
```

The fetch script also needs `curl`, `sha256sum` and `python3` (only to read the JSON lock file at build time; the installed app does not need Python). Linux packages must be built on Linux.

</details>

<details>
<summary><b>Android</b></summary>

- **JDK 17** (Android Studio's bundled `jbr` works).
- **Android SDK** with Platform-Tools, Build-Tools, Command-line Tools and **NDK (Side by side)**. CI uses NDK `27.2.12479018` and installs `platforms;android-37.0` and `build-tools;37.0.0`, matching the Gradle project Tauri CLI 2.12 generates.
- Environment variables `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`.
- The Rust target `aarch64-linux-android` (the default arm64 build). Add the other three targets only for a universal or all-ABI build.

Or skip all of this and use the Docker build in [`docker/android`](docker/android) (see [Build the Android APK](#4-build-the-android-apk)).

Windows (cmd), then open a new terminal:

```cmd
setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
dir /b "%LOCALAPPDATA%\Android\Sdk\ndk"
setx NDK_HOME "%LOCALAPPDATA%\Android\Sdk\ndk\<version printed above>"
rustup target add aarch64-linux-android
```

Linux:

```bash
export JAVA_HOME=/opt/android-studio/jbr
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk")"
rustup target add aarch64-linux-android
```

You need about 10 GB of disk space for Android Studio, the SDK and the NDK.

</details>

### 1. Fetch the sidecar binaries (desktop only)

yt-dlp, ffmpeg and qjs (QuickJS-NG) are **not committed**. The fetch scripts download them into `src-tauri/binaries` as `<name>-<target-triple>[.exe]` (the names Tauri's `externalBin` expects) and check every file's SHA-256 against [`scripts/binaries.lock.json`](scripts/binaries.lock.json); a mismatch stops the script. CI runs the same scripts. There is no ffprobe: Keepsake never calls it, and yt-dlp falls back to ffmpeg.

```bash
# Windows (writes *-x86_64-pc-windows-msvc.exe)
bun run binaries

# Linux (writes *-x86_64-unknown-linux-gnu)
bash scripts/fetch-binaries.sh
```

`bun run binaries` runs [`scripts/fetch-binaries.ps1`](scripts/fetch-binaries.ps1). Pass `-Triple <triple>` to that script directly if your host triple differs (check it with `rustc --print host-tuple`). Android needs no sidecars: [`tauri.android.conf.json`](src-tauri/tauri.android.conf.json) sets `"externalBin": []`.

| Binary | Source | Hash |
|---|---|---|
| yt-dlp 2026.08.19 | Official yt-dlp GitHub release, standalone PyInstaller build (no Python needed on the user's machine) | Pinned |
| ffmpeg | [ffmpeg-ytdl-minimal-build](https://github.com/Abdullah-Masood-05/ffmpeg-ytdl-minimal-build) v1.1.0: FFmpeg 7.1.1 configured as **LGPL**, with only what yt-dlp needs (about 6 MB) | Pinned |
| qjs | [QuickJS-NG](https://github.com/quickjs-ng/quickjs) v0.18.0 (about 2 MB) | Pinned |

The minimal ffmpeg can merge streams without re-encoding, convert audio (MP3, Opus, WAV, FLAC, AAC) and convert thumbnails. It has no video encoders and no network protocols, so it cannot re-encode video or download on its own; Keepsake never asks it to.

### 2. Install, check and run

```bash
bun install
bun run typecheck
bun run lint
bun run dev          # starts the app in development mode
```

Unit tests: `bun test` (engine tests in [`src/engine/__tests__`](src/engine/__tests__), editor tests in [`src/editor/__tests__`](src/editor/__tests__); they need no network and start no processes), `cd src-tauri && cargo test` (Rust) and `python -m pytest -q src-tauri/plugins/keepsake-media/android/src/test/python` (Android Python bridge, with `PYTHONPATH=src-tauri/plugins/keepsake-media/android/src/main/python`).

Testing on a device: the Android phone checklist is in [docs/ANDROID_SELFCONTAINED.md](docs/ANDROID_SELFCONTAINED.md#how-to-test-on-a-phone). Every known open risk, with the exact CI step or device test that checks it, is in [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md).

`bun run dev:web` starts only the Vite front end in a browser. It is for UI work: the browser's CORS rules block real fetches, so links fail with a "browser preview" error.

### 3. Build installers

| Command | Output |
|---|---|
| `bun run build:windows` | `src-tauri/target/release/bundle/nsis/*.exe` (NSIS only) |
| `bun run build:linux` | `src-tauri/target/release/bundle/{deb,rpm,appimage}/` |
| `bun run build:desktop` | All bundle targets for the current OS |

### 4. Build the Android APK

```bash
bun run android:init     # once; generates src-tauri/gen/android (git-ignored)
bash scripts/android-patch-gradle.sh   # after every android:init; adds Chaquopy (needs Python 3.12 on PATH)
                                       # and turns on native-lib extraction for the bundled executables
bash scripts/build-android-ffmpeg.sh   # builds libffmpeg.so with the NDK (slow the first time; see below)
bash scripts/fetch-android-binaries.sh # downloads libqjs.so, checks every SHA-256 (Windows: scripts/fetch-android-binaries.ps1)
bun run build:android    # arm64 APK (the default build)
```

The two Android executables are **not committed**. They go to `src-tauri/plugins/keepsake-media/android/src/main/jniLibs/arm64-v8a/` and are pinned in the `android` block of [`scripts/binaries.lock.json`](scripts/binaries.lock.json):

| File | What | Source |
|---|---|---|
| `libqjs.so` | QuickJS-NG v0.18.0 | Official release asset `qjs-linux-aarch64`, renamed, SHA-256 pinned. [`scripts/build-android-qjs.sh`](scripts/build-android-qjs.sh) is the NDK build fallback if that binary does not run on Android |
| `libffmpeg.so` | FFmpeg 7.1.1, minimal LGPL configuration with LAME 3.100 and Opus 1.5.2 | Built from pinned source tarballs by `scripts/build-android-ffmpeg.sh` with the NDK (`27.2.12479018` in CI) |

Android only lets an app run programs from its native-library folder, so both are packaged as `lib*.so` files and extracted at install time. yt-dlp-ejs 0.8.0 is a pip pin in the plugin's `build.gradle.kts` and must change together with the yt-dlp pin. CI runs the same steps and then checks that both libraries are in the APK and that native-lib extraction is on. The exact order of these steps is in the `android` job of [`.github/workflows/build.yml`](.github/workflows/build.yml), which is authoritative if it differs from the list above.

| Command | What it does |
|---|---|
| `bun run android:dev` | Run on a connected device or emulator with live reload |
| `bun run build:android` | 64-bit ARM APK (`tauri android build --apk --target aarch64`). The default; minSdk is 24 (Android 7.0) |
| `bun run build:android:arm64` | Same as `build:android` |
| `bun run build:android:split` | One APK per ABI (needs all four Rust Android targets) |
| `bun run build:android:universal` | One APK with all four ABIs; several times larger (needs all four targets) |

The bundled ffmpeg on Android is used only by yt-dlp (merging streams and audio extraction on the self-contained route). WAV conversion and the legacy TikTok/Instagram mux use the small Kotlin plugin in [`src-tauri/plugins/keepsake-media`](src-tauri/plugins/keepsake-media), built on Android's own `MediaExtractor`, `MediaCodec` and `MediaMuxer`.

**Docker build (no local Android toolchain):** [`docker/android/build-android.ps1`](docker/android/build-android.ps1) builds an image with JDK 17, the SDK, NDK, Rust 1.90.0 and Bun, then builds the arm64 APK into `apk-out/`. Pass `-AllAbis` for the universal APK and every ABI split. With a release keystore in `%USERPROFILE%\.keepsake` (`keepsake-release.jks` plus `keystore.password`), it is mounted read-only and the APK is release-signed; otherwise the APK is debug-signed and for testing only.

Output lands under `src-tauri/gen/android/app/build/outputs/apk/`. Add `--debug` (for example `bun run build:android --debug`) for a debug-signed APK that installs directly; install it over USB with `adb install -r <file.apk>`.

Release APKs must be signed before Android installs them. Follow [Tauri's Android signing guide](https://v2.tauri.app/distribute/sign/android/): create a keystore, write `src-tauri/gen/android/keystore.properties`, and add a `release` signing config to `src-tauri/gen/android/app/build.gradle.kts`. Because `gen/` is regenerated in CI, either commit it after the edits or script them in CI.

### Continuous integration

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs on pushes to `main`, on pull requests, on `v*` tags and by hand.

| Job | Runner | Builds | Artifacts |
|---|---|---|---|
| `check` | `ubuntu-22.04` | Typecheck, lint, `bun test`, pytest (Android Python bridge), front-end build, `cargo test` | none |
| `windows` | `windows-latest` (MSVC) | `tauri build --bundles nsis`, then `scripts/verify-bundle.ps1` (checks the bundled sidecars) | `keepsake-windows-nsis` |
| `linux` | `ubuntu-22.04` | `tauri build --bundles deb,rpm,appimage`, then `scripts/verify-bundle.sh` (checks the bundled sidecars) | `keepsake-linux-deb`, `keepsake-linux-rpm`, `keepsake-linux-appimage` |
| `android-ffmpeg` | `ubuntu-latest` (NDK) | Builds `libffmpeg.so` (FFmpeg, LAME, Opus) | `android-ffmpeg-arm64`; on tags also `keepsake-android-ffmpeg-sources` |
| `android` | `ubuntu-latest` (JDK 17, SDK, NDK) | `tauri android init --ci`, then an arm64 APK build and APK checks (native libs, extractNativeLibs, 16 KiB alignment, yt-dlp-ejs) | `keepsake-android-apk` |
| `release` | `ubuntu-latest` | Runs on `v*` tags only, after the builds | Draft GitHub Release with every installer |

The `windows` and `linux` jobs were switched off earlier (`if: false`, "Android-only builds for now") and are enabled again; they run on every push to `main` and every pull request, which costs CI minutes.

You can build the APK entirely in GitHub Actions without installing the Android toolchain: push, open the **Actions** tab, and download `keepsake-android-apk` from the run's **Artifacts**.

The workflow assumes this folder is the repository root. If it is a subfolder, move `.github` to the repository root and set `KEEPSAKE_DIR` at the top of `build.yml`.

## Releasing

1. Bump the version in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) (and keep [`package.json`](package.json) and [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) in step). The current version is **2.1.0**.
2. Tag the commit with the same version and push the tag:

   ```bash
   git tag v2.1.0
   git push origin v2.1.0
   ```

3. CI builds every platform, then the `release` job collects all installers into a **draft** GitHub Release with generated release notes.
4. Review the draft on GitHub and publish it.

## Settings

Settings save automatically; there is no Save button. **Reset** restores the defaults.

| Setting | Default | Notes |
|---|---|---|
| Save folder | System Downloads folder | On Android, files go to the app's private files folder |
| Parallel downloads | 3 | 1 to 10 |
| Cookies from browser | Off | Firefox, Chrome, Edge, Brave, Opera, Vivaldi or Chromium. Desktop only. Firefox works best on Windows; close Chromium-based browsers before fetching |
| Embed thumbnail as cover art (audio) | On | MP3 and M4A. Desktop only |
| Embed thumbnail and metadata (video) | Off | Each embed pass rewrites the whole video file, so it is off by default for speed. Desktop only |
| Prefer H.264 | Off | Best compatibility. YouTube offers H.264 up to 1080p only |
| Detect links in clipboard | Off | Offers a copied link on Home |
| Theme | System | System, Light or Dark |

## Keyboard shortcuts

On Windows and Linux, `Ctrl` is the modifier.

| Shortcut | Action |
|---|---|
| `Ctrl` + `1` / `2` / `3` / `4` / `5` / `6` | Go to Home / Downloads / Library / Favorites / Sources / Settings |
| `Ctrl` + `7` | Go to the Editor |
| `Ctrl` + `L` | Focus the link field on Home |
| `Ctrl` + `V` | On Home (outside a text field): paste the clipboard link and fetch it |
| `Ctrl` + `Enter` | On Home: start the download |
| `Ctrl` + `F` | Focus the Library search |
| `Ctrl` + `B` | Collapse or expand the sidebar (desktop) |
| `Ctrl` + `Shift` + `L` | Switch between dark and light theme |

## Architecture

```text
+-----------------------------------------------------------------+
|  UI: React 19 + Tailwind CSS 4 + motion   (src/pages, components)|
|  State: settings, downloads queue, library (src/state)          |
+--------------------------------+--------------------------------+
                                 |
                                 v
+-----------------------------------------------------------------+
|  Engine (TypeScript, src/engine)                                |
|  fetchInfo / listFormats / startDownload / binaryStatus         |
+----------------+-------------------------------+----------------+
                 |  Windows / Linux              |  Android
                 v                               v
+-------------------------------+   +-----------------------------+
| Tauri command run_ytdlp (Rust)|   | youtubei.js (YouTube only)  |
|   -> yt-dlp sidecar           |   |   + BotGuard PO token       |
|   -> ffmpeg sidecar (minimal) |   | adaptive video + audio      |
|   -> qjs sidecar (QuickJS),   |   |   -> keepsake-media mux     |
|      else a user-installed    |   |   (MP4/WebM, no re-encode)  |
|      Node.js                  |   | files via plugin-http/fs    |
| YouTube info: youtubei.js,    |   | audio: AAC -> M4A, -> WAV   |
|   falling back to yt-dlp -J   |   | TikTok/IG: bundled yt-dlp   |
+-------------------------------+   +-----------------------------+

Rust (src-tauri) is a thin Tauri shell: plugins (dialog, fs, http,
opener, keepsake-media on Android), window, and the validated yt-dlp
launcher on desktop.
```

The engine API and the yt-dlp argument contract are documented in [`src/engine/CONTRACT.md`](src/engine/CONTRACT.md).

## Project structure

```text
.
├── .github/workflows/build.yml   CI: checks and tests, Windows, Linux, Android builds, draft releases
├── docker/android/               Dockerfile and scripts for a containerised Android APK build
├── docs/                         Background notes (historical research, not specs)
├── scripts/                      Sidecar fetch scripts and binaries.lock.json (pinned SHA-256)
├── src/
│   ├── App.tsx                   App shell, splash, shortcuts
│   ├── pages/                    Home, Downloads, Library, Settings
│   ├── components/
│   │   ├── layout/               Sidebar, tab bar, titlebar, splash
│   │   ├── features/             Format picker, preview card, download rows, library list
│   │   └── ui/                   Buttons, dialogs, fields, toasts and other primitives
│   ├── engine/                   Extraction, download and conversion logic (contract: CONTRACT.md)
│   │   └── __tests__/            bun unit tests (formats, yt-dlp arguments, error mapping, android-ytdlp, reliability)
│   ├── state/                    Stores for settings, downloads, library, theme
│   ├── lib/types.ts              Shared engine types
│   └── styles/                   Theme CSS
└── src-tauri/
    ├── src/                      lib.rs, main.rs, ytdlp.rs (yt-dlp launcher)
    ├── plugins/keepsake-media/   Android plugin (Kotlin + Python): audio conversion, mux, Gallery and folder saves,
    │                             Media3 video editor, and the bundled yt-dlp bridge (Chaquopy)
    ├── capabilities/             desktop.json, mobile.json
    ├── binaries/                 Sidecars yt-dlp, ffmpeg, qjs (downloaded, not committed)
    ├── icons/
    ├── installer/                NSIS installer artwork
    └── tauri*.conf.json          Base config plus Windows, Linux and Android overrides
```

## Security and privacy

- **No accounts, no telemetry.** Keepsake talks only to the sites you download from. Nothing is downloaded from a CDN at runtime; every helper program ships inside the installer.
- **No shell access from the webview.** The shell plugin is not used; the capabilities grant no `shell:*` permission. yt-dlp runs only through the `run_ytdlp` Rust command.
- **Fixed, validated yt-dlp arguments.** Rust always prepends `--ignore-config --no-plugin-dirs --no-js-runtimes`, then the JavaScript runtime by absolute path (`--js-runtimes quickjs:<bundled qjs>`, or `node:<path>` as the fallback) and `--ffmpeg-location`, so no user or system yt-dlp config is loaded. Every option must be on an allow-list; options that run programs or load code (`--exec`, `--downloader`, `--postprocessor-args`, `--plugin-dirs`, `--config-location`, `--batch-file`, `--ffmpeg-location` and others) are rejected, and the URL must be a single `http(s)://` link after `--`.
- **Content Security Policy.** Scripts load only from the app itself (`'unsafe-eval'` is allowed because youtubei.js needs it to decipher stream URLs), and images may load from `https:` for thumbnails. See [`tauri.conf.json`](src-tauri/tauri.conf.json).
- **Scoped network and file access.** The HTTP plugin may only reach YouTube, Google video and image hosts. File access is limited to the Downloads, Video, Audio, app data and app cache folders, plus a folder you pick. Opening files from the app is limited to the download folders.
- **Cookies stay with you.** Cookies are read only from the browser you choose in Settings, and only when you turn that on. They are passed to yt-dlp for the request and not stored by Keepsake.

## Troubleshooting

<details>
<summary><b>"yt-dlp is missing or damaged"</b></summary>

The sidecar was not bundled or was removed. Reinstall Keepsake. When building from source, run the fetch script (step 1 of [Build from source](#build-from-source)) before `bun run dev`.

</details>

<details>
<summary><b>"ffmpeg is missing"</b></summary>

Merging high-resolution video and audio conversion need ffmpeg. Reinstall Keepsake, or re-run the fetch script when building from source. Settings > Components shows the detected yt-dlp and ffmpeg versions.

</details>

<details>
<summary><b>YouTube downloads fail on desktop</b></summary>

yt-dlp needs a JavaScript runtime to solve YouTube's challenges. Keepsake bundles QuickJS (`qjs`); Settings > Components shows which runtime was found. If none was found, reinstall Keepsake (or re-run the fetch script when building from source). As a fallback, installing Node.js also works: Keepsake looks for it on `PATH` and in the usual install folders.

</details>

<details>
<summary><b>Age-restricted, private or members-only videos</b></summary>

Choose your browser under **Settings > Cookies from browser** (desktop only). Sign in to the site in that browser first. Firefox works best on Windows; close Chromium-based browsers before fetching, because they lock their cookie database.

</details>

<details>
<summary><b>Android: where are my files?</b></summary>

Files are saved to the app's private folder, `/storage/emulated/0/Android/data/com.keepsake.app/files/Download`. Many file managers hide `Android/data`; open files from Keepsake's Library instead. **Android deletes this folder when you uninstall Keepsake**, so copy anything you want to keep first.

</details>

<details>
<summary><b>Android: "Only YouTube, TikTok and Instagram links can be downloaded on this device" or playlist errors</b></summary>

Expected. Other sites and playlists need the Windows or Linux app.

</details>

<details>
<summary><b>Android: other TikTok and Instagram messages</b></summary>

- **Rate limit (HTTP 429):** the site is limiting requests. Wait a few minutes and try again.
- **Refused (HTTP 403):** the post may be private or restricted.
- **Not found (HTTP 404):** the link is wrong or the video was removed.
- **Needs a login:** the Android app cannot log in yet. Try a public post or use the desktop app.
- **Not enough space:** free some storage on the phone and retry.
- **Can't write to the folder:** pick the save folder again in Settings.
- **File too large:** files over 500 MB are refused.
- **Couldn't combine video and audio:** retry; if it keeps failing, pick another quality.
- **Nothing was downloaded (empty file):** retry later; the site may have changed.
- **Cancelled:** you stopped the download.

</details>

<details>
<summary><b>Android: "Can't save to ..."</b></summary>

Folder access from the picker lasts for one session. Pick the folder again in Settings, or clear it to use the default.

</details>

<details>
<summary><b>Android: where are MP3, FLAC and OPUS? Why do I sometimes get 360p?</b></summary>

On Android, TikTok and Instagram downloads run on the phone through the bundled yt-dlp. When a post serves video and audio as separate streams, Keepsake combines them on the phone without re-encoding. Audio from TikTok and Instagram is M4A only; there is no MP3 on Android. The app is about 35-50 MB per install (an estimate) because it carries Python, yt-dlp, QuickJS-NG and a minimal ffmpeg.

For YouTube, Android offers M4A and WAV only for now. M4A is the original audio with no conversion; WAV is decoded on the phone by Android's own media codecs. MP3 needs an encoder Android does not include, and FLAC and Opus encoders are missing on some supported Android versions.

Video is normally every quality the link offers through the bundled yt-dlp. If Copy diagnostics does not show `ready: yes` for it, or YouTube answers with a bot check, see [docs/ANDROID_SELFCONTAINED.md](docs/ANDROID_SELFCONTAINED.md#troubleshooting-by-problems-word); Keepsake then uses the fallback path: it mints a PO token in the app's WebView and combines the separate video and audio streams on the phone (MP4 or WebM, no re-encoding). If that token cannot be minted, YouTube refuses the high-quality URLs and Keepsake falls back to the 360p progressive MP4, which needs no token. Check Settings > Components > **Copy diagnostics**: "PO token ready" means the fallback's high-quality path is working. For MP3, FLAC and OPUS, use the desktop app.

</details>

<details>
<summary><b>Windows dev build: "resource path binaries\keepsake-yt-dlp-x86_64-pc-windows-gnu.exe doesn't exist"</b></summary>

Your Rust default toolchain is the GNU one, so Tauri looks for `-gnu` sidecar names. Either switch to MSVC (`rustup default stable-x86_64-pc-windows-msvc`), or fetch the binaries under the GNU names:

```cmd
powershell -ExecutionPolicy Bypass -File scripts\fetch-binaries.ps1 -Triple x86_64-pc-windows-gnu
```

</details>

<details>
<summary><b>Linux: <code>.deb</code> / <code>.rpm</code> conflicts with a system yt-dlp</b></summary>

These packages install the sidecars (`yt-dlp`, `ffmpeg`, `qjs`) next to the app in `/usr/bin`, which can clash with a distribution `yt-dlp` or `ffmpeg` package. Use the self-contained AppImage instead.

</details>

## Roadmap

- [ ] Android: MP3, FLAC and OPUS output
- [ ] Android: save to the public Downloads folder (MediaStore)
- [ ] Measure real installer and APK sizes in CI and replace the estimates above
- [ ] System tray
- [ ] Code signing for Windows installers and release-signed Android APKs

## Credits

Keepsake is built on these projects:

- [Tauri](https://tauri.app): the app shell and plugins
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): extraction and downloads on desktop, and YouTube/TikTok/Instagram on Android (Unlicense)
- [yt-dlp-ejs](https://github.com/yt-dlp/ejs): yt-dlp's YouTube challenge solver scripts on Android (Unlicense AND MIT AND ISC; includes meriyah and astring)
- [Chaquopy](https://chaquo.com/chaquopy/): runs Python and yt-dlp inside the Android app (MIT)
- [FFmpeg](https://ffmpeg.org): merging and conversion on desktop and, for yt-dlp, on Android. The bundled build is a minimal **LGPL-2.1-or-later** configuration (with [LAME](https://lame.sourceforge.io) and [Opus](https://opus-codec.org)) from [ffmpeg-ytdl-minimal-build](https://github.com/Abdullah-Masood-05/ffmpeg-ytdl-minimal-build) on desktop and the same configuration built with the NDK on Android
- [QuickJS-NG](https://github.com/quickjs-ng/quickjs): the JavaScript runtime yt-dlp uses for YouTube on desktop and Android (MIT)
- [youtubei.js](https://github.com/LuanRT/YouTube.js): YouTube info and Android downloads
- Android's built-in `MediaExtractor`, `MediaCodec` and `MediaMuxer`: audio conversion on Android
- [React](https://react.dev), [motion](https://motion.dev), [Tailwind CSS](https://tailwindcss.com), [Vite](https://vite.dev) and [Bun](https://bun.sh)

## Legal

Keepsake is a tool. It does not host, store or distribute any media. Only download content you have the right to download, such as your own uploads, content in the public domain or under a permissive license, or content the owner allows you to save. Respect each site's terms of service and copyright law in your country. The authors are not responsible for how the software is used.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository and create a branch.
2. Run `bun install`, then make your change.
3. Before opening a pull request, run `bun run typecheck`, `bun run lint` and `cd src-tauri && cargo test`.
4. Keep download logic in `src/engine` and keep the Rust side thin.

## License

Keepsake is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, copy, modify and share it free of charge for any noncommercial purpose. Commercial use is not permitted: you may not sell Keepsake, or any product or service built on it, without a separate commercial license from the authors.

Bundled third-party components (yt-dlp, yt-dlp-ejs, FFmpeg with LAME and Opus, QuickJS-NG, and on Android Chaquopy, CPython and certifi) keep their own licenses. Keepsake's license covers Keepsake's own code only and places no restriction on them. FFmpeg (LGPL-2.1-or-later) and QuickJS-NG (MIT) run as separate programs; Keepsake does not link to them. The full list, the license texts and where to get the corresponding FFmpeg, LAME and Opus source are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the Android app also carries the license texts under `assets/licenses/`.
