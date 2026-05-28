# Third-party notices

Keepsake bundles the programs and packages below. **They keep their own licences.** Keepsake's own licence (the
[`LICENSE`](LICENSE) file) covers Keepsake's own code only and places no restriction on these components, and
nothing in Keepsake's licence limits the rights their licences give you.

Keepsake runs **FFmpeg** and **QuickJS-NG** as **separate programs** (child processes started by yt-dlp). It does
not link to them. yt-dlp is started as a separate program on desktop and runs as a Python package inside the app on
Android.

The verbatim licence texts for the Android-bundled components are in
[`src-tauri/plugins/keepsake-media/android/src/main/assets/licenses/`](src-tauri/plugins/keepsake-media/android/src/main/assets/licenses/)
and ship inside the APK under `assets/licenses/`. Its `README.txt` lists the exact source URL and SHA-256 of
every text.

## Components

| Component | Version | Licence | Platforms | How it is used |
|---|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 2026.08.19 (desktop), 2026.10.26 (Android) | Unlicense | all | Desktop: official standalone build, separate program. Android: pip package in Chaquopy |
| [yt-dlp-ejs](https://github.com/yt-dlp/ejs) | 0.8.0 | Unlicense AND MIT AND ISC (bundles meriyah 6.1.4, ISC, and astring 1.9.0, MIT) | Android | pip package; its scripts are executed by QuickJS-NG |
| [QuickJS-NG](https://github.com/quickjs-ng/quickjs) | v0.18.0 | MIT | all | Separate program (`qjs` sidecar on desktop, `libqjs.so` on Android) |
| [FFmpeg](https://ffmpeg.org) | 7.1.1, minimal build | LGPL-2.1-or-later | all | Separate program (`ffmpeg` sidecar on desktop, `libffmpeg.so` on Android) |
| [LAME](https://lame.sourceforge.io) | 3.100 | LGPL-2.0-or-later | all | Statically linked into the ffmpeg program |
| [libopus](https://opus-codec.org) | 1.5.2 | BSD-3-Clause | all | Statically linked into the ffmpeg program |
| [zlib](https://zlib.net) | not pinned (the build host's zlib) | Zlib | desktop; Android see note | Desktop: statically linked into the ffmpeg program. Android: if the NDK build enables zlib it links Android's own system `libz.so`, which is not shipped in the APK; the notice is included either way |
| [Chaquopy](https://chaquo.com/chaquopy/) runtime | 17.2.0 | MIT | Android | Runs Python inside the app |
| CPython | 3.12 | PSF License | Android | Bundled by Chaquopy |
| [certifi](https://github.com/certifi/python-certifi) | 2026.10.23 | MPL-2.0 | Android | CA bundle for yt-dlp |

Front-end and Rust dependencies (React, Tauri, youtubei.js and others) are listed with their licences in
`package.json`/`bun.lock` and `src-tauri/Cargo.toml`/`Cargo.lock`; they are not repeated here. The Android plugin's
Gradle dependencies (AndroidX Core, AppCompat and Media3 Transformer/Effect/Common 1.8.1, all Apache-2.0; Media3 runs
the Android video editor) are listed in `src-tauri/plugins/keepsake-media/android/build.gradle.kts`.

## FFmpeg (LGPL-2.1-or-later)

- The bundled ffmpeg is an **unmodified** FFmpeg 7.1.1 (`n7.1.1`) configured **without** `--enable-gpl` and
  **without** `--enable-nonfree`, so it is licensed under the **GNU Lesser General Public License version 2.1 or
  later**. It contains LAME 3.100 (LGPL-2.0-or-later), libopus 1.5.2 (BSD-3-Clause) and zlib (Zlib licence).
- Desktop build: [ffmpeg-ytdl-minimal-build](https://github.com/Abdullah-Masood-05/ffmpeg-ytdl-minimal-build)
  release `v1.1.0` (its `build.sh` at that tag is the build script).
- Android build: [`scripts/build-android-ffmpeg.sh`](scripts/build-android-ffmpeg.sh) in this repository, run in
  CI with the Android NDK, using the same LGPL configure flags as the desktop build. The recipe and the pinned
  source hashes are recorded in the `android` block of [`scripts/binaries.lock.json`](scripts/binaries.lock.json).
  If an Android release of ffmpeg-ytdl-minimal-build is used instead, the lock file names it.
- Corresponding source (SHA-256 as pinned in `scripts/binaries.lock.json`):
  - FFmpeg: <https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz>
    (`733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1`; tag `n7.1.1` of <https://github.com/FFmpeg/FFmpeg>)
  - LAME: <https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz>
    (`ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`)
  - Opus: <https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz>
    (`65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1`)
  - Each Keepsake GitHub release that ships these binaries is meant to carry the exact source tarballs above as
    release assets, so the source is available from the same place as the binaries.
- You may replace the bundled ffmpeg with your own build of FFmpeg. On desktop, replace the `ffmpeg` sidecar file.
  On Android, rebuild the APK with your `libffmpeg.so` in
  `src-tauri/plugins/keepsake-media/android/src/main/jniLibs/arm64-v8a/`.
- Licence texts: FFmpeg's `COPYING.LGPLv2.1` and LAME's `COPYING` are in the licences folder linked above
  (`FFMPEG-LGPL-2.1.txt`, `LAME-LGPL-2.0.txt`), together with `OPUS-BSD-3.txt` and `ZLIB.txt`.

## QuickJS-NG (MIT)

Upstream release `v0.18.0`: the official prebuilt binaries are used (`qjs-linux-aarch64` renamed to `libqjs.so` on
Android), pinned by SHA-256 in `scripts/binaries.lock.json`. Copyright (c) 2017-2026 Fabrice Bellard,
Charlie Gordon, Ben Noordhuis and Saúl Ibarra Corretgé. Full MIT text: `QUICKJS-NG-MIT.txt`.

## yt-dlp-ejs (Unlicense AND MIT AND ISC)

Installed from PyPI (`yt_dlp_ejs-0.8.0-py3-none-any.whl`, SHA-256
`79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4`). The package itself is under the Unlicense; its
bundled solver library includes meriyah 6.1.4 (ISC, Copyright (c) 2019 and later, KFlash and others) and astring
1.9.0 (MIT, Copyright (c) 2015, David Bonnet). All three texts: `YT-DLP-EJS.txt`.

## No GPL components in the media stack

None of the components above is GPL-licensed, and the bundled ffmpeg is not a GPL build (no `--enable-gpl`). The
Android packaging technique (executables shipped as `lib*.so` in `jniLibs`) is a generic Android mechanism; no
code or build scripts from GPL projects (for example youtubedl-android, NewPipe, Termux or ffmpeg-kit scripts)
were used for it.
