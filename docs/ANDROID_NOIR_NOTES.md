# Android: lessons from Noir Player

> **Historical research, not a spec.** These notes record what was learned on 2026-11-09. They are not a plan and not a description of how Keepsake works now. For the current Android behaviour see [`src/engine/CONTRACT.md`](../src/engine/CONTRACT.md) and the README.
>
> Corrections made after review (2026-11-10):
> - **Licence.** Noir's Android code that came from NewPipe (and NewPipe Extractor itself) is **GPL-3.0**. Keepsake has **no licence chosen yet** (README, "License"), so it is *not* "GPL like Keepsake", and none of that code may be copied or ported into Keepsake. The same applies to youtubedl-android. Keepsake's Android plugin (`src-tauri/plugins/keepsake-media`) is written from the Android platform APIs only.
> - **Decision taken instead of option A below:** keep youtubei.js for YouTube, drop ffmpeg.wasm, and convert audio with a small Kotlin plugin over `MediaExtractor` / `MediaCodec` / `MediaMuxer`. Android ships M4A and WAV, 360p video, arm64 APK.
> - **Unverified numbers.** The APK and install sizes in section 2 (63 MB, ~257 MB, ~125 MB, "a few MB"), the certificate details, the "533 lines" count, the NewPipe Extractor / NewPipe version pairing and the request details (1 MiB ranges, POST body, `&rn=`) come from Noir's commit messages and source and were not re-checked. Do not quote them as facts.
> - Section 3 describes Keepsake as it was on 2026-11-09 (ffmpeg.wasm, a fix then thought uncommitted). Both are out of date; see the notes inline.

Notes from 2026-11-09 on how [noir-music-player-android](https://github.com/Abdullah-Masood-05/noir-music-player-android) (Noir, Flutter) handles signing and YouTube on Android, and what that means for Keepsake's Android build.

## 1. APK signing

Noir signs its releases with a real release keystore, not the debug key.

| | Noir |
|---|---|
| applicationId | `com.example.noir_player` (Flutter template placeholder; Play Store rejects `com.example.*`) |
| Certificate | `CN=Noir Player, O=Abdullah Masood`, RSA 4096, valid 2026-10-04 to 2054-02-19 |
| SHA-256 | `D1:12:84:FB:F6:CF:EA:33:A8:FE:6B:E5:35:C1:F4:84:0D:4F:E0:72:98:B3:46:69:C9:1A:0F:6A:C1:83:3D:2A` |
| Signature schemes | v2 only |

How it works:
- `android/app/build.gradle.kts` loads `key.properties` if it exists and uses a `release` signing config; otherwise it falls back to the debug key.
- `key.properties`, `*.jks` and `*.keystore` are gitignored. Nothing secret is committed.
- CI (`.github/workflows/ci.yml`, "Configure release signing") decodes the keystore from GitHub secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` into `$RUNNER_TEMP`, writes `key.properties`, builds, and deletes both in an `if: always()` step.
- `release.yml` reuses the CI artifact, runs `apksigner verify --print-certs`, refuses `CN=Android Debug` (unless repo variable `ALLOW_DEBUG_SIGNED_RELEASE=true`), and checks the digest against repo variable `ANDROID_RELEASE_CERT_SHA256`.

This is the same pattern NewPipe and the [Tauri signing docs](https://v2.tauri.app/distribute/sign/android/) use.

**For Keepsake:** use a separate key (`CN=Keepsake, O=Abdullah Masood`) stored at `%USERPROFILE%\.keepsake\keepsake-release.jks` (alias `keepsake`), with the password in `keystore.password` next to it. The Docker build (`docker/android/` at the repository root; there is no `rust-tauri` folder) mounts that folder read-only and patches `gen/android/app/build.gradle.kts`. Without the key it falls back to the debug key, which is for testing only. Back the key up: if it's lost, installed copies can never be updated. Mirror Noir's CI secrets and fingerprint check when adding Android CI.

## 2. How Noir reaches YouTube

### History
1. `feat(discover): find, play and download songs with yt-dlp on the phone (Android)`: yt-dlp via youtubedl-android.
2. `feat(discover): reach YouTube with NewPipe Extractor instead of yt-dlp (Android)`. The commit gives the reason:
   > On-device yt-dlp needed Python and FFmpeg (63 MB arm64 APK, ~257 MB installed) and was slow to start. NewPipe Extractor, the library behind the NewPipe app, does the same job in a few MB.
3. `fix(discover): free the space yt-dlp's unpacked files took in test builds`: deletes `noBackupFilesDir/youtubedl-android` and `cacheDir/ytdlp` (~125 MB).

### Current setup
- **Dependencies** (`android/app/build.gradle.kts`):
  - `com.github.TeamNewPipe:NewPipeExtractor:v0.26.5` from JitPack (same version as NewPipe 0.29.1)
  - `com.squareup.okhttp3:okhttp:4.12.0`
  - `coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.5")` with `isCoreLibraryDesugaringEnabled = true`
  - ProGuard/R8 keep rules for classes NewPipe Extractor and Rhino load by name
- **Ported from NewPipe (GPL-3.0; not usable in Keepsake, see the note at the top):** `DownloaderImpl` (as `NewPipeDownloader.kt`), `org/schabi/newpipe/streams/{DataReader, Mp4DashReader, Mp4FromDashWriter, io/SharpStream}.java`, `us/shandian/giga/io/FileStream.java`.
- **`YouTubeChannel.kt`** (533 lines) handles the Flutter method channel `noir/youtube`: `resolve`, `download`, `finish`, `cancel`, with progress on `noir/youtube/progress`.

### Techniques worth knowing about (ideas only; re-implement from public docs, never copy the GPL code)
- **Init:** `NewPipe.init(downloader, Localization.fromLocale(locale), ContentCountry(country))`.
- **Stream choice:** only `isUrl && deliveryMethod == PROGRESSIVE_HTTP`; skip `DUBBED`/`DESCRIPTIVE` audio tracks, prefer `ORIGINAL`, prefer M4A, then highest bitrate.
- **Headers per client**, following NewPipe's player rules:
  - User-Agent from `YoutubeParsingHelper.isAndroidStreamingUrl / isIosStreamingUrl / isVisionOsStreamingUrl` → `getAndroidUserAgent / getIosUserAgent / getVisionOsUserAgent`
  - `Origin`/`Referer: https://www.youtube.com` and `Sec-Fetch-*` **only** for WEB / embedded-player URLs
- **Requests like YouTube's apps:** a POST with a tiny body, `&rn=<requestNumber>` appended to `/videoplayback` URLs, `Range: bytes=a-b`, `Accept-Encoding: identity`.
- **Speed:** 1 MiB ranges, several in parallel. One long request gets throttled to playback speed.
- **Finishing:** `Mp4FromDashWriter` turns the DASH file into a normal MP4/M4A in pure Java with no ffmpeg (Noir also adds tags and a cover in a `udta` box).
- **No PO token code.** Noir only fetches audio, and gets it without one.

## 3. Keepsake's Android situation on 2026-11-09 (for comparison)

- Android has **no yt-dlp**. It had youtubei.js (YouTube only) and ffmpeg.wasm (audio conversion only). *Since replaced: ffmpeg.wasm is removed and audio goes through the native `keepsake-media` plugin (M4A, WAV).* `src/engine/download.ts` rejects non-YouTube links, so Instagram works on desktop (yt-dlp sidecar) but not on Android.
- **HTTP 403 on Android downloads.** Tested 2026-11-09 against video `18c3MTX0PK0`, using youtubei.js 18.3.0:

  | Client | Result |
  |---|---|
  | ANDROID_VR (was first) | Plain URLs, 403 on every request: bound to a PO token |
  | ANDROID | Only itag 18 (360p progressive) has a URL; downloads fine |
  | IOS | 403 once a range is larger than ~0.5–1 MB |
  | TV | Unplayable |
  | WEB | No URLs (SABR) |
  | MWEB | URLs with `n`, 403 even after deciphering |

  Fix: Android tries `ANDROID` first. This is **committed** (`src/engine/youtube.ts`, in commit 3afa61e); an earlier version of these notes wrongly called it uncommitted. Audio was then taken from the 360p MP4 through ffmpeg.wasm, because that client has no audio-only stream; today the AAC track is copied to M4A (or decoded to WAV) by the `keepsake-media` plugin instead.
- Keepsake's `http.ts` sends youtube.com Origin/Referer to googlevideo for every client, which is exactly what Noir's header rules avoid.

## 4. Options for Keepsake on Android (as considered on 2026-11-09)

Options A to D all depend on GPL-3.0 code (NewPipe Extractor, NewPipe's muxer, youtubedl-android), so none of them can be taken while Keepsake has no licence or a licence incompatible with GPL-3.0. The sizes are the unverified commit-message figures.

| Option | YouTube | Instagram and other sites | APK cost |
|---|---|---|---|
| **A. Noir-style:** port NewPipe Extractor + muxer into a Kotlin Tauri plugin (GPL-3.0) | Good; higher qualities and video+audio merge need testing | No | A few MB (unverified) |
| **B. yt-dlp only** (youtubedl-android, Noir's first attempt; GPL-3.0) | Yes | All yt-dlp sites | +~60 MB APK, ~257 MB installed, slow first start (unverified) |
| **C. Hybrid:** NewPipe for YouTube, yt-dlp for other sites | Fast | Yes | Same as B |
| **D. Two builds:** "Lite" (A) and "Full" (C) | Yes | Full build only | Users choose |

Not covered by Noir and still needing checks:
- Whether video-only streams above 360p download without a PO token through NewPipe Extractor's clients. Noir only proves it for audio.
- Whether NewPipe Extractor v0.26.5 is still current and working (YouTube changes often).
- PO tokens: NewPipe's WebView BotGuard provider, if higher qualities need one.
- How yt-dlp on Android handles YouTube's JavaScript challenge (yt-dlp needs an external JS runtime).

~~**Suggested first step:** option A (port Noir's Kotlin into a Keepsake Tauri plugin and test 720p/1080p). Options C and D build on it.~~ *Superseded:* porting is blocked by the licence (see the top of this file). The chosen path is youtubei.js plus a Kotlin plugin written from the platform media APIs; whether DASH streams above 360p download without a PO token is still the open question.

## Sources
- Noir repo: `android/app/build.gradle.kts`, `android/app/src/main/kotlin/com/example/noir_player/YouTubeChannel.kt`, `.github/workflows/ci.yml`, `release.yml`, commit history
- [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor) · [NewPipe](https://github.com/TeamNewPipe/NewPipe)
- [F-Droid: Reproducible Builds](https://f-droid.org/en/docs/Reproducible_Builds/) · [Tauri: Android Code Signing](https://v2.tauri.app/distribute/sign/android/)
