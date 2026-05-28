# Android: self-contained yt-dlp (QuickJS-NG + LGPL ffmpeg)

Status: implemented in code, **not yet run on a device**. Nothing in this note has been confirmed on a phone.
CI builds and checks the APK; the device test table below is how the route gets signed off.
Design and reasoning: `plan-docs/11-android-selfcontained-ytdlp.md` (outside this repo folder, next to it).

## How it works

Desktop yt-dlp works well because it has three helpers: a JavaScript runtime (QuickJS-NG), the EJS challenge
solver scripts, and ffmpeg. Android yt-dlp (Python 3.12 inside the app through Chaquopy) used to have none of
them. This route gives it all three:

| Piece | Where it lives in the APK / on the phone | Licence |
|---|---|---|
| yt-dlp 2026.10.26 | Chaquopy pip package, runs in the app process | Unlicense |
| yt-dlp-ejs 0.8.0 (solver scripts) | Chaquopy pip package; must match yt-dlp's own pin | Unlicense AND MIT AND ISC |
| QuickJS-NG v0.18.0 | `lib/arm64-v8a/libqjs.so`, a separate program | MIT |
| FFmpeg 7.1.1 minimal LGPL build | `lib/arm64-v8a/libffmpeg.so`, a separate program | LGPL-2.1-or-later |

1. Android only lets an app execute files from its `nativeLibraryDir`, and the installer only places files there
   that are packaged as `lib/<abi>/lib*.so` with native-lib extraction on. So the two programs ship as
   `libqjs.so` and `libffmpeg.so` (they are ordinary executables with a `.so` name), and the Gradle patch turns
   on `useLegacyPackaging` so they are extracted at install time.
2. On first use, Kotlin passes `nativeLibraryDir` and the cache folder to the Python bridge (`configure`).
3. Python sets `js_runtimes={'quickjs': {'path': <dir>/libqjs.so}}`, `ffmpeg_location=<dir>/libffmpeg.so` and
   a persistent `cachedir`, and leaves YouTube's `player_client` at yt-dlp's defaults, exactly like the desktop
   sidecar. yt-dlp starts qjs and ffmpeg as child processes (fork/exec); nothing is linked into the app.
4. TS asks `ytdlp_status` first. Only when the build flag `ANDROID_SELFCONTAINED` is true **and** the status says
   `ready: true` does it use this route, and in this first version only for YouTube links. Any non-final error on
   the route falls back once to the old YouTube path (youtubei.js). TikTok and Instagram are unchanged.
5. Downloads send the same format selectors the desktop app uses (`selectionArgs` in `src/engine/ytdlp.ts`),
   so yt-dlp itself picks, downloads and merges the streams with ffmpeg.

Contract details (commands, arguments, errors): `src/engine/CONTRACT.md`, section 3.2.
Licences and source offer: `THIRD_PARTY_NOTICES.md` and, inside the APK, `assets/licenses/`.

## How to test on a phone

Setup: the CI APK `keepsake-<ver>-arm64-v8a-testsigned.apk`; `adb install -r`; package `com.keepsake.app`
(VERIFIED `tauri.conf.json` identifier).

Logs:
```
adb logcat -c
adb logcat -v time python.stdout:V python.stderr:V AndroidRuntime:E DEBUG:V chromium:I *:S > keepsake.log
adb shell dumpsys package com.keepsake.app | grep -i nativeLibraryDir
adb shell ls -l <that dir>          # expect libqjs.so, libffmpeg.so, -rwxr-xr-x
```
WebView console (TS fallback decisions): `chrome://inspect` on the PC. Set `no_warnings: False` (already) and,
for the test build only, `verbose: True` behind a diagnostics switch, so yt-dlp prints `[jsc:quickjs]`,
`[youtube] ... player_client` and `[Merger]` lines to `python.stderr`.

| ID | Case | Expected |
|---|---|---|
| S1 | Fresh install, Settings > Copy diagnostics | `yt-dlp 2026.10.26, EJS 0.8.0, QuickJS-ng 0.18.0, ffmpeg 7.1.1..., ready: yes` |
| S2 | Same on Android 10-12 device and 14+ device | same; if `ffmpeg_exec_denied`/`qjs_exec_denied` then R1/R2/R3, stop |
| S3 | Airplane mode, then S1 | still `ready: yes` (status is offline) |
| Y1 | YouTube 1080p public video (e.g. `https://www.youtube.com/watch?v=aqz-KE-bpKQ`, Big Buck Bunny), fetch | heights up to 1080p (2160p if offered); log shows a quickjs solve, client `tv_samsung`; time-to-info recorded (expected < 15 s cold, < 5 s warm) |
| Y2 | Download 1080p | one MP4 (or MKV for VP9/AV1+Opus), plays with sound in Gallery; `[Merger]` in the log; no `.fNNN` leftovers in the cache |
| Y3 | Download "Best available" on a 4K video | 2160p VP9/AV1 merged to MKV/MP4; plays (codec support is device-dependent: note it, not a fail) |
| Y4 | YouTube Shorts link and `youtu.be/ID` link | canonicalised; 1080p vertical saved |
| Y5 | YouTube Audio M4A | `.m4a` AAC, no re-encode (`-x` copy) |
| Y6 | Age-restricted or members-only video | clean `login_required`/`bot_check` message; no crash; fallback note in the console |
| T1 | TikTok public video, Best | highest height, no watermark variant preferred; plays |
| T2 | TikTok video whose best is video-only bytevc1 + separate audio (was unmuxable before) | merged by ffmpeg; plays |
| T3 | TikTok photo/slideshow post | the existing "photos, not a video" row |
| I1 | Instagram public reel | best height (often DASH video-only + audio: merged) |
| I2 | Instagram post with HLS-only formats (if found) | downloaded via hlsnative + FixupM3u8 (needs the mpegts demuxer, which is in the build) |
| I3 | Instagram private post | `login_required` |
| X1 | Install a build with the flag false | everything behaves as today's release |
| X2 | Cancel during video download, and during merge | `cancelled`; no files left in the cache or target |
| X3 | Two parallel downloads (YouTube + TikTok) | both finish |

Record per case: device, Android version, result, time, and the relevant 20 log lines. Attach `keepsake.log`.

R1-R3 in S2 refer to the risks in the plan: R1 fork/exec from Python blocked, R2 libraries not extracted
(`extractNativeLibs` not true), R3 the static musl `qjs` does not run on Android.

Note on the MVP scope: this first version uses the route for **YouTube only**. TikTok and Instagram keep
today's path (one concrete format plus the native muxer), so in this build T1-T3 and I1-I3 are regression checks
of the unchanged path, and T2/I1/I2 may still show today's limits (no ffmpeg merge for them yet). They become
real tests of the new route once TikTok/Instagram are switched over (plan phase 1).

## Troubleshooting by `problems` word

`ytdlp_status` returns `problems: string[]`, short machine words. The authoritative list is the `status()`
function in `src-tauri/plugins/keepsake-media/android/src/main/python/keepsake_ytdlp.py`; if a word there is
missing below, read that function. The words the plan defines:

| Word | Meaning | What to check |
|---|---|---|
| `qjs_missing` | `libqjs.so` is not in `nativeLibraryDir` | `unzip -l <apk> \| grep libqjs.so`. If it is in the APK but not on the phone, native libs were not extracted (R2): check `extractNativeLibs` in the merged manifest (`aapt2 dump xmltree --file AndroidManifest.xml <apk>`) and that `scripts/android-patch-gradle.sh` patched the app module. If it is not in the APK, `scripts/fetch-android-binaries.sh` did not run before the build. |
| `qjs_exec_denied` | The file exists but cannot be executed, or running it fails | `adb shell ls -l <nativeLibraryDir>` should show `-rwxr-xr-x`. If permissions are fine, the static musl binary may not run on this Android (R3) or fork/exec from Python is blocked (R1): look for `Permission denied`, `Exec format error` or a seccomp `SIGSYS` in `keepsake.log`. Fallback: build QuickJS-NG with the NDK (plan WP-A2). |
| `ffmpeg_missing` | `libffmpeg.so` is not in `nativeLibraryDir` | Same checks as `qjs_missing`, for `libffmpeg.so`. |
| `ffmpeg_exec_denied` | `libffmpeg.so -version` cannot run | Same checks as `qjs_exec_denied`. If both binaries fail the same way, suspect R1 (fork/exec from the Chaquopy process) before the binaries themselves. |
| `ejs_missing` | `import yt_dlp_ejs` fails | `build.gradle.kts` of the plugin must `install("yt-dlp-ejs==0.8.0")`; check the Chaquopy requirements in the APK. |
| `ejs_mismatch` (or similar) | The solver version does not match the pin yt-dlp expects | yt-dlp and yt-dlp-ejs must be bumped together: the yt-dlp-ejs version must equal the `yt-dlp-ejs==` pin in that yt-dlp version's `pyproject.toml`. |

Other symptoms:

- **`ready: yes` but YouTube still shows 360p only.** The route fell back. Open `chrome://inspect`, look for the
  fallback note and the error code. `bot_check` means YouTube challenged the phone's IP or client (R4); this is a
  known open question (bgutil PO-token provider), not a bug in the route.
- **`js_runtime_missing` / `ytdlp_missing` errors during a download.** yt-dlp reported that it could not find a
  JS runtime or ffmpeg. Compare with `ytdlp_status`; the route should not have been chosen when `ready` is false.
- **Slow first fetch.** QuickJS solves the YouTube player challenge on the phone CPU. The first solve is cached in
  `<cache>/yt-dlp`, so the next fetch should be faster (Y1 records cold and warm times).
- **Cancel during a merge waits a few seconds.** A running ffmpeg merge is not interrupted; its output is deleted
  when it finishes (accepted risk R8).
