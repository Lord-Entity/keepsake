# Engine contract

## 1. TypeScript API (`src/engine/index.ts`)

| Export | Signature | Notes |
|---|---|---|
| `fetchInfo` | `(url: string, opts?: { signal?: AbortSignal; cookiesBrowser?: string }) => Promise<VideoInfo>` | Rejects with `EngineError` (an `Error` that is also an `AppError`). |
| `listFormats` | `(info: VideoInfo \| null \| undefined) => FormatOption[]` | Lists only what the current platform can produce (section 1.1). `null` gives disabled "Fetch a video first" video rows plus the audio/thumbnail rows. Respect `disabledReason` and `isDefault` (one default per mode). |
| `startDownload` | `(req: DownloadRequest, onProgress: (p: DownloadProgress) => void) => DownloadHandle` | Starts at once; the caller owns queueing and the 1-10 parallel limit. `handle.done` never rejects. The final `onProgress` call has status `done`, `failed` or `cancelled`. |
| `binaryStatus` | `() => Promise<BinaryStatus>` | Desktop: from `binary_status`. Android/web: `"unsupported"`. |
| `platform` | `() => "windows" \| "linux" \| "android" \| "web"` | |
| `toAppError`, `friendlyError`, `qualityLabel` | helpers | |

`DownloadRequest.formatId` is a `FormatOption.id`: `video:best`, `video:<height>`, `audio:<mp3|m4a|opus|wav|flac>`, `thumb:<original|png|jpg>`.

Embedding flags on `DownloadRequest` (desktop only):
- `embedVideoMeta` (video): embed thumbnail and metadata. **Off unless `true`.** Each embed pass rewrites the whole video file, so it is opt-in (Settings default `false`).
- `embedThumbnail` (audio): embed cover art into MP3/M4A. **On unless `false`** (Settings default `true`). Metadata is always embedded into audio.

### 1.1 Per platform

| | Windows / Linux | Android | Web (dev preview) |
|---|---|---|---|
| Info | YouTube via youtubei.js, falling back to yt-dlp `-J`; other sites via yt-dlp | YouTube via the self-contained yt-dlp route when it is on and ready (section 3.2), else youtubei.js; TikTok and Instagram via yt-dlp (Chaquopy, in-process); others reject with `unsupported_url` | YouTube only; plain-browser fetches fail with `web_cors` |
| Video | Every height the link offers, plus "Best available"; yt-dlp merges video-only + audio | YouTube, self-contained route (section 3.2, `info.ytdlpFull`): the desktop rows (every height plus "Best available"), downloaded and merged by yt-dlp with the bundled ffmpeg. Otherwise YouTube: youtubei.js with a PO token (section 1.3); every height the video offers down to 144p, plus "Best available". A video-only stream is paired with a matching audio-only stream and copy-muxed on the phone (MP4 for AVC/HEVC+AAC, WebM for VP8/VP9+Vorbis/Opus, AV1 to MP4 on Android 10+). Without a token, or when no pair exists: the progressive MP4 at or below 360p, exactly as before. Accepted links (https): hosts `youtube.com`, `www.`, `m.`, `music.youtube.com`, `youtu.be`; forms `watch?v=`, `youtu.be/ID`, `/shorts/`, `/live/`, `/embed/`; canonicalised to `https://www.youtube.com/watch?v=ID`; playlist-only URLs rejected. TikTok/Instagram: every height the phone can save, plus "Best available"; video-only heights are merged with an audio stream on the phone (copy-mux, no re-encode); list and pick share `bestStreamsByHeight` (section 3.1) | Same as Android |
| Audio | MP3 (default), M4A, OPUS, WAV, FLAC | **M4A (default) and WAV only.** MP3, FLAC and OPUS are not listed. TikTok/Instagram: M4A only | None |
| Thumbnail | Original, PNG, JPG | Original, PNG, JPG. TikTok/Instagram: not offered on Android | Original, PNG, JPG |
| Playlists | Yes, per-item progress | Rejected (`format_unavailable`: "Playlists can be downloaded in the desktop app only.") | Rejected |
| Downloads via | yt-dlp sidecar (`run_ytdlp`) | YouTube self-contained route: one `ytdlp_download` with `args` (section 3.2). Otherwise range requests through plugin-http, streamed to disk with plugin-fs | Range requests into a Blob, then `<a download>` |
| Conversion via | ffmpeg sidecar, run by yt-dlp | `keepsake-media` Tauri plugin (section 3) | None |

### 1.3 Android YouTube quality: PO token + adaptive mux

YouTube binds every high-quality `googlevideo` URL to a PO token. The Android client still lists the formats without one, but each request answers 403; only ANDROID itag 18 (360p progressive) downloads unchecked. Keepsake therefore mints a token on the phone:

- `src/engine/po-token.ts` runs Google's BotGuard in the app's own WebView with `bgutils-js` (CSP already allows `'unsafe-eval'` for youtubei.js). Challenge and integrity token go through `www.youtube.com/api/jnn/v1`, already allowed by the `http` capability; no Deno, Node or extra host.
- The player token is bound to the session's `visitor_data` and attached as `po_token` to every `getBasicInfo` client (`youtube.ts`), then cached until shortly before the integrity token expires.
- All of it is fail-soft: a missing interpreter, blocked challenge or network error resolves to `null` and the old 360p path runs unchanged. Nothing in the engine throws because of it.
- This section is now the **fallback** YouTube path. The primary path is the self-contained yt-dlp route (section 3.2): yt-dlp with the bundled QuickJS-NG and EJS solver uses its default clients, which need no PO token, as on desktop. The old reason for keeping yt-dlp off YouTube ("in-process yt-dlp cannot solve challenges without Node/Deno") no longer holds once QuickJS-NG is bundled. This PO-token path is removed only after device sign-off (plan 11, WP-K).
- `resolveAdaptive(videoId, maxHeight)` (`youtube.ts`) picks the best video-only stream at or below the requested height and its matching audio-only stream (same container: mp4 for AAC, webm for Opus/Vorbis). `download.ts` streams both to `$APPCACHE/mux-<id>/`, then calls `muxAndroid`; output follows the codec matrix in section 3, and no re-encoding happens.
- Diagnostics: Settings > Components > "Copy diagnostics" reports the platform, WebView, app version and whether the PO token is minted (`poTokenStatus()`), so a bug report can tell "token failed" from "no pair at that height".

### 1.2 Cancel semantics

- `handle.cancel()` is idempotent. After it, no further non-final `onProgress` calls are delivered and the final status is `cancelled` (error code `cancelled`), even if the work finished in the same tick.
- Desktop: `cancel()` sets the flag and sends `cancel_ytdlp`. Because a cancel sent before Rust registers the job is a no-op, `runYtdlp` checks the flag before invoking, re-sends `cancel_ytdlp` on the first output line and once more 500 ms after start. The yt-dlp process tree is killed and `.keepsake-tmp/<jobId>` is deleted by Rust. Cookie-fallback retries stop as soon as the flag is set.
- Android/web: `cancel()` aborts the `AbortSignal` that every Range request uses. Partial output and the temp file in the app cache are deleted. The native `transcode` call cannot be interrupted; a cancel during it is honoured as soon as it returns, and the converted output is then deleted.
- Android yt-dlp (TikTok/Instagram): `cancel()` does not interrupt the running native job; its output is deleted when it returns and the final status is `cancelled`. Aborting `fetchInfo` rejects with `cancelled` at once and the native result is dropped.
- `fetchInfo`: aborting `opts.signal` rejects with `cancelled`; on desktop it also sends `cancel_ytdlp` for the `info-<UUID>` job.

## 2. Tauri commands (Rust, `src-tauri/src/ytdlp.rs`)

### `run_ytdlp`
```ts
invoke<number>("run_ytdlp", { jobId: string, args: string[], tempDir: string | null, onEvent: Channel<YtdlpEvent> })
type YtdlpEvent = { event: "stdout"; line: string } | { event: "stderr"; line: string };
```
- Spawns the `yt-dlp` sidecar with Rust's fixed flags prepended: `--ignore-config --no-plugin-dirs --no-js-runtimes [--js-runtimes <runtime>:<absolute path>] --ffmpeg-location <sidecar dir>/keepsake-ffmpeg(.exe)` (the FILE: given a folder, yt-dlp only finds a binary named `ffmpeg`). A job that merges or converts fails with "ffmpeg not found" when that file is missing. TS never sends any of these.
- Env `PYTHONIOENCODING=utf-8`. Windows: `CREATE_NO_WINDOW` + Job Object (kill on close). Unix: `process_group(0)`.
- Sends every stdout/stderr line (no trailing newline, UTF-8, lossy decode) on `onEvent` as it arrives.
- Resolves with the exit code when the process exits (after both pipes are drained; -1 = killed by a signal). Rejects only if validation or spawning fails; the message includes "yt-dlp" and "not found" when the binary is missing.
- Validation (the webview builds the args, so Rust must not trust them): the last two args are `--` and one `http(s)://` URL; every option must be on the allow-list. Always rejected: `--exec`, `--exec-before-download`, `--config-location(s)`, `--batch-file`/`-a`, `--load-info-json`, `--netrc-cmd`, `--external-downloader`/`--downloader`, `--downloader-args`, `--postprocessor-args`/`--ppa`, `--plugin-dirs`, `--use-postprocessor`, `--ffmpeg-location`, `--remux-video`, `--recode-video`. `--js-runtimes` from TS is accepted only as `node` or `node:<absolute path>` (TS does not send it).
- `tempDir` (download jobs only) is `<outDir>/.keepsake-tmp/<jobId>`: created with a `.keepsake-job` marker before spawning and deleted after exit (success, failure or cancel). Nothing else in `outDir` is touched.
- `jobId` is a UUID (downloads) or `info-<UUID>` (fetchInfo).

### `cancel_ytdlp`
```ts
invoke<void>("cancel_ytdlp", { jobId: string })
```
Kills the process tree for `jobId` (Windows: Job Object; Unix: SIGTERM to the group, SIGKILL after 2 s), waits for exit, then cleans `tempDir`. No-op if the job is unknown (already finished or not registered yet; see 1.2). The pending `run_ytdlp` call then resolves with the exit code and TS reports `cancelled`.

### `binary_status`
```ts
invoke<{ ytdlp: string | null; ffmpeg: string | null; node: string | null }>("binary_status")
```
Shape unchanged. `ytdlp`: `yt-dlp --version`. `ffmpeg`: first line of `ffmpeg -version`. `node`: the version of the **JS runtime `run_ytdlp` will use** (bundled QuickJS-NG text when the `qjs` sidecar is present, else `node --version`), or `null` when none is found. The field keeps the name `node` for compatibility; `BinaryStatus.node` / `nodeVersion` mirror it. Results are cached by path, size and mtime, so a warm start spawns nothing.

### `list_installed_browsers`
```ts
invoke<string[]>("list_installed_browsers")
```
yt-dlp browser names (`edge chrome firefox brave chromium opera vivaldi`) whose profile folder exists (Windows: `%LOCALAPPDATA%` / `%APPDATA%`; Linux: `~/.config`, `~/.mozilla`, snap Firefox). Used by the cookie fallback.

### External binaries (desktop sidecars)

`tauri.conf.json` `externalBin`: `binaries/keepsake-yt-dlp`, `binaries/keepsake-ffmpeg`, `binaries/keepsake-qjs`. Tauri appends the target triple, so the fetch scripts write `src-tauri/binaries/<name>-<target-triple>[.exe]` and check SHA-256 against `scripts/binaries.lock.json`.

| Sidecar | What | Used for |
|---|---|---|
| `yt-dlp` | Official PyInstaller build 2026.08.19 (no host Python needed) | Extraction and download |
| `ffmpeg` | Minimal LGPL build, `ffmpeg-ytdl-minimal-build` v1.1.0 | Stream-copy merge, audio transcode (MP3, Opus, WAV, FLAC), thumbnail conversion, embedding |
| `qjs` | QuickJS-NG v0.18.0 | YouTube JavaScript challenges |

**No ffprobe.** It is not bundled and Keepsake never calls it; yt-dlp falls back to `ffmpeg -i` for probing. The minimal ffmpeg has no video encoders, no network protocols and no HLS/DASH demuxers, so TS never asks for a re-encode or remux.

Android has no Tauri sidecars (`tauri.android.conf.json` sets `"externalBin": []`). The self-contained route instead ships `libqjs.so` and `libffmpeg.so` as jniLibs of the `keepsake-media` plugin (section 3.2), fetched by `scripts/fetch-android-binaries.sh` and pinned in the `android` block of `scripts/binaries.lock.json`.

### JS runtime and cookie fallback
- Rust picks the runtime: the bundled `qjs` sidecar (`--js-runtimes quickjs:<absolute path>`) when the file exists; otherwise a user-installed Node, looked up on PATH, then `%ProgramFiles%\nodejs`, `C:\Program Files\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`, `%NVM_SYMLINK%` (Windows) or `/usr/local/bin`, `/usr/bin` (Linux) (`--js-runtimes node:<absolute path>`). The Node fallback must keep working.
- Neither found + YouTube URL: `run_ytdlp` rejects with `js_runtime_missing: ...` (TS code `js_runtime_missing`). Neither found + other site: runs with no JS runtime.
- Bot check (`bot_check`) with Settings > Cookies "off": TS retries once per installed browser in the order edge, chrome, firefox, brave, chromium, opera, vivaldi with `--cookies-from-browser <b>`, stops at the first success (download result `note: "Retried with cookies from <Browser>"`), else returns `bot_check` (cookiesHint true). An explicit browser choice is never overridden. Applies to downloads and to yt-dlp info fetches. `cancelled`, `js_runtime_missing` and `ytdlp_missing` end the loop at once.

## 3. Android native plugin `keepsake-media` (`src-tauri/plugins/keepsake-media`)

Kotlin, written against the platform `MediaExtractor` / `MediaCodec` / `MediaMuxer` APIs only (no GPL code; the Kotlin code never calls ffmpeg, which only yt-dlp runs on the route in section 3.2). TS wrapper: `src/engine/android-media.ts`, exporting `transcodeAudio(args)` and `isAndroidMediaAvailable()`.

```ts
invoke<{ path: string }>("plugin:keepsake-media|transcode", {
  input: string,          // absolute path of the downloaded file (temp file in the app cache)
  output: string,         // absolute path of the final file
  format: "wav" | "m4a",
  kbps?: number,          // reserved for future encoders; ignored by "wav" and "m4a"
})
```
- `m4a`: copy the AAC track into an MPEG-4 audio container (no re-encode; any video track is dropped). Used when the audio came from a progressive MP4 or a muxed file.
- `wav`: decode the audio track to 16-bit PCM and write a WAV header.
- Resolves `{ path }` (the written file). Rejects with a message on any failure; the wrapper maps "plugin not found / not allowed" to `format_unavailable` and everything else to `unknown`.
- Capability: `keepsake-media:allow-transcode` in `src-tauri/capabilities/mobile.json`.
- M4A from an audio-only AAC stream needs no plugin call: the file is saved as served.
- Not supported this round: MP3 (needs LAME), FLAC and Opus (encoder availability per API level unverified; Opus needs API 29, minSdk is 24). The engine rejects them with `format_unavailable` before any network work, and `listFormats` does not offer them.

### 3.1 Android yt-dlp commands (legacy route: TikTok and Instagram, YouTube fallback)

Same plugin, yt-dlp 2026.10.26 (pure Python) running in-process through Chaquopy, arm64 only. TS wrapper: `src/engine/android-ytdlp.ts`. Details: `plan-docs/07-android-ytdlp-plan.md`. Everything in this section is the **legacy route** (`full` absent or `false`) and stays byte-identical. YouTube through yt-dlp uses the self-contained route in section 3.2.

```ts
invoke<{ ok: true; info: YtdlpInfo }>("plugin:keepsake-media|ytdlp_info", { url: string })
invoke<{ path: string; bytes: number }>("plugin:keepsake-media|ytdlp_download",
  { url: string, formatId: string, outDir: string, fileName?: string })
```
- Hosts: https only, `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`, `instagram.com`, `instagr.am` (exact or subdomain). Checked in TS (`isAndroidYtdlpHost`) and again in Rust.
- `YtdlpInfo` is a reduced payload: `id, title, uploader, duration, thumbnail, extractor, webpage_url, formats[]`; each format has `format_id, ext, vcodec, acodec, height, fps, filesize, protocol, format_note`, plus optional numbers `tbr`, `abr`, `width` (absent or `null` when unknown). No stream URLs, headers or cookies reach JS.
- `formatId` is ONE concrete yt-dlp `format_id` (`A-Z a-z 0-9 _ - .`, 1..64 chars) taken from the info; TS only picks http/https single-file formats (m3u8/HLS and DASH-segment formats are dropped in `ytdlpInfoToVideoInfo`).
- Quality list and pick (TikTok/Instagram/other non-YouTube) share one function, `bestStreamsByHeight(info)` in `android-ytdlp.ts`: `listFormats` (`formats.ts`) shows exactly its heights and `pickYtdlpFormat` downloads exactly the stream it holds for the chosen height, so a listed height never silently resolves to a different or lower file.
  - Per height, a progressive stream (any codec, copied as-is) or a video-only stream the phone can mux (AVC/HEVC in mp4 + AAC, VP8/VP9/AV1 in webm + Opus/Vorbis) with a matching audio-only stream. Heightless streams are not listed.
  - Same-height ranking: non-watermarked first (watermarked `format_note` or `download*` ids are demoted, not dropped), then progressive, fps, bitrate (`tbr`), size.
  - Audio ranking (mux partner and `audio:m4a`): bitrate (`abr` for audio-only streams, else `tbr`), then size.
  - Rows: `video:best` ("Best available", resolves to the highest listed height) plus one `video:<h>` per height. Default: highest height <= 1080, else Best available.
  - The pick's `fallback` (best progressive at or below the picked height, when it is a different file) is used only after `format_unavailable` / `mux_failed`.
  - A muxed pick carries `muxExt`, the extension the native muxer writes (`muxOutputExt`: AV1 -> mp4, else the container); `download.ts` names and collision-checks the output with it.
  - YouTube-via-yt-dlp (flag off) keeps its own pick (`pickVideoYouTube`). `outDir` is an absolute path inside the allowed roots; `fileName` is a base name without extension. Download re-runs extraction (no info cache on the native side).
- Capabilities: `keepsake-media:allow-ytdlp-info`, `keepsake-media:allow-ytdlp-download`.
- Errors reject with `ytdlp:<code>: <message>` (TS searches for it, since Tauri may wrap the text). Codes (16): `unsupported_url`, `login_required`, `rate_limited`, `forbidden`, `not_found`, `parse_failed`, `network`, `timeout`, `no_space`, `permission`, `too_large`, `cancelled`, `format_unavailable`, `mux_failed`, `empty`, `unknown`. They map to the same-named `AppErrorCode`, with Android-specific texts and `cookiesHint: false` always. A missing plugin or permission maps to `ytdlp_missing`.
- Added commands (reliability round, see `plan-docs/08-download-reliability-changes.md`):
  ```ts
  invoke<{ ok: true; info: YtdlpInfo }>("plugin:keepsake-media|ytdlp_info", { url })            // as above
  invoke<{ path: string; bytes: number }>("plugin:keepsake-media|ytdlp_download",
    { url, formatId, outDir, fileName?, jobId })    // one stream per call; TS sends jobId "job" when none is given. A video-only height is two calls (video, then audio) followed by ytdlp_mux
  invoke<unknown>("plugin:keepsake-media|ytdlp_cancel", { jobId })                               // stops that job; TS never throws from it
  invoke<{ path: string; bytes: number }>("plugin:keepsake-media|ytdlp_mux",
    { videoPath, audioPath, outDir, fileName })     // copy-mux (no re-encode) into MP4 or WebM
  ```
  Capabilities: `keepsake-media:allow-ytdlp-cancel`, `keepsake-media:allow-ytdlp-mux`.
  Inputs may be `.mp4/.webm/.mkv/.part` (video) and `.m4a/.aac/.mp4/.webm/.opus/.ogg/.part` (audio); the file name is a base name without extension. `KeepsakeMux.kt` chooses the container from the probe codecs: AVC/HEVC + AAC -> MP4; VP8/VP9 + Vorbis/Opus -> WebM; AV1 + AAC/Opus -> MP4 on API 29+, else `mux_failed`. Nothing is re-encoded.
- Extra error codes (same `ytdlp:<code>: <message>` form, same-named `AppErrorCode`): `no_space` (storage full), `permission` (cannot write the folder), `too_large` (over 2 GiB), `mux_failed` (combining streams failed), `cancelled` (user stopped the job), `empty` (nothing was downloaded). Retries (`runWithRetry` in `android-ytdlp.ts`): `network`, `timeout` and `rate_limited` are retried twice, with waits of 2 s then 6 s; `no_space`, `permission` and the rest are not retried.
- Limits: one yt-dlp job at a time (single native thread); files over 2 GiB are refused; M4A audio only (a progressive MP4 is remuxed with `transcode` when no m4a stream exists).
- Out of scope: progress events (indeterminate bar), cookies or login, proxies, user yt-dlp options, MP3/FLAC/Opus/WAV, thumbnails, playlists and carousels, other sites, in-app yt-dlp updates.

### 3.2 Self-contained yt-dlp route (Android, YouTube only in this MVP)

Plan: `plan-docs/11-android-selfcontained-ytdlp.md` (sections 3.7 and 8). Phone test plan and troubleshooting: [`docs/ANDROID_SELFCONTAINED.md`](../../docs/ANDROID_SELFCONTAINED.md). **Nothing in this section has been run on a device yet**; CI checks packaging only.

The APK bundles two separate programs in `lib/arm64-v8a/` (extracted to `nativeLibraryDir`, the only app-owned place Android lets an app execute from): `libqjs.so` (QuickJS-NG v0.18.0) and `libffmpeg.so` (FFmpeg 7.1.1 minimal LGPL build, no ffprobe), plus the pip package `yt-dlp-ejs==0.8.0` (the EJS solver scripts; the version must equal the pin in the bundled yt-dlp's `pyproject.toml`). With `full: true` the Python bridge sets `js_runtimes={'quickjs': {'path': <nativeLibraryDir>/libqjs.so}}`, `ffmpeg_location=<nativeLibraryDir>/libffmpeg.so` and `cachedir=<cache>/yt-dlp`, and leaves `player_client` at yt-dlp's defaults (as the desktop sidecar does). These values are always set by the bridge, never taken from TS.

```ts
invoke<YtdlpStatus>("plugin:keepsake-media|ytdlp_status", {})
type YtdlpStatus = {
  ytdlp: string;            // yt_dlp.version.__version__
  ejs: string | null;       // yt_dlp_ejs version, null when not importable
  jsRuntime: string | null; // QuickJS runtime info, e.g. "quickjs-ng 0.18.0", null when not runnable
  ffmpeg: string | null;    // first line of `libffmpeg.so -version`, null when not runnable
  ready: boolean;           // all four present and the ejs version matches the pin
  problems: string[];       // short machine words, e.g. "qjs_missing", "ffmpeg_exec_denied", "ejs_missing"
};
invoke<{ ok: true; info: YtdlpInfo }>("plugin:keepsake-media|ytdlp_info", { url, full?: boolean })
invoke<{ path: string; bytes: number }>("plugin:keepsake-media|ytdlp_download",
  { url, formatId?: string, args?: string[], outDir, fileName?, jobId, full?: boolean })
```

- **`ytdlp_status`**: works offline, never throws for a missing piece (problems are data). Capability `keepsake-media:allow-ytdlp-status`. TS caches it per session (`androidYtdlpStatus()`); any invoke error (old plugin, missing permission, command not found) counts as not ready. The authoritative `problems` words are in `keepsake_ytdlp.py::status()`.
- **`full`** (default `false`): `false` keeps the legacy behaviour of section 3.1 byte-identical. `true` turns on the bundled runtime, solver and ffmpeg. `ytdlp_info` with `full` keeps HLS/DASH formats (TS sets `VideoInfo.ytdlpFull = true` and does not filter to muxable pairs).
- **`ytdlp_download`: exactly one of `formatId` or `args`**, else the call is rejected (`ytdlp:unknown:`).
  - `formatId`: one concrete id, or two joined by one `+` (`^[A-Za-z0-9_.-]{1,64}(\+[A-Za-z0-9_.-]{1,64})?$`, e.g. `"137+140"`). The `+` form needs ffmpeg. `"a+b+c"`, `"a+"`, `"+a"`, `"a,b"` are rejected.
  - `args`: 1..24 items, the selection argv from `selectionArgs(req, { platform: "android" })` in `ytdlp.ts` (the same selectors desktop `buildDownloadArgs` uses). Allow-list, checked in Rust (`validate_selection_args`) and again in Python: `-f`/`--format` value `^[A-Za-z0-9_.+/\[\]<>=!*?^$:~-]{1,200}$` (no comma, space or quotes); `-S`/`--format-sort` value `^[a-z0-9:,+_.-]{1,100}$`; `--merge-output-format` in `{mp4/mkv, mp4, mkv, webm}`; `-x`; `--audio-format` in `{m4a}`; `--audio-quality` `^\d{2,3}K$`; `--embed-metadata`; `--embed-thumbnail`; `--convert-thumbnails` in `{jpg, png}`. Everything else is rejected, including `-o`, `-P`, `--exec*`, `--ffmpeg-location`, `--js-runtimes`, `--remote-components`, `--extractor-args`, `--postprocessor-args`, `--plugin-dirs`, `--config-location*`, `--cookies*`, `--load-info-json` and `--`. Python keeps only the option keys `format`, `format_sort`, `merge_output_format`, `postprocessors`, `writethumbnail`, `final_ext`, and only postprocessors `FFmpegExtractAudio`, `FFmpegMetadata`, `EmbedThumbnail`, `FFmpegThumbnailsConvertor`.
  - Result: the final merged path (`.mp4`, or `.mkv` when the streams do not fit MP4; `.m4a` for audio). Merge intermediates (`*.fNNN.*`) are removed. WAV is an M4A download followed by the native `transcode`.
- **Errors**: same `ytdlp:<code>: <message>` form as section 3.1. New codes (already in `AppErrorCode`, used by desktop): `js_runtime_missing` (no usable JS runtime), `ytdlp_missing` (ffmpeg or solver missing), `bot_check` ("confirm you're not a bot", matched before `login_required`).
- **Flag and routing**: `ANDROID_SELFCONTAINED` (build-time constant in `youtube-ytdlp.ts`) **and** `ytdlp_status().ready` must both be true; otherwise every path behaves exactly as before. In this MVP only **YouTube** links use the route (info with `full: true`, download through `runAndroidYtdlpFull` in `download.ts`, rows from `formats.ts` when `info.ytdlpFull`). TikTok and Instagram stay on section 3.1 unchanged.
- **Fallback rule**: any non-final error on the route (`js_runtime_missing`, `ytdlp_missing`, `parse_failed`, `format_unavailable`, `bot_check`, `unknown`) falls back **once** to the legacy YouTube path (youtubei.js, section 1.3). Final errors (`cancelled`, `no_space`, `permission`, `too_large`, `not_found`, `login_required`) never fall back.
- **Cancel**: `ytdlp_cancel` sets the job's flag; it is checked between downloads and postprocessors. A running ffmpeg merge is not interrupted; its output is deleted when it returns and the final status is `cancelled`.
- Capabilities: `keepsake-media:allow-ytdlp-status` (new) plus the existing `allow-ytdlp-info`, `allow-ytdlp-download`, `allow-ytdlp-cancel`.
- Licences: `THIRD_PARTY_NOTICES.md` (repo root) and `assets/licenses/` inside the APK. FFmpeg and QuickJS-NG run as separate programs; Keepsake does not link to them.

## 4. Arguments TS sends (for reference and Rust tests)

Every call: `--encoding utf-8 --no-warnings [--cookies-from-browser <b>]`. Rust prepends its fixed flags (section 2), so TS never sends `--ignore-config`, `--no-plugin-dirs`, `--js-runtimes`, `--no-js-runtimes` or `--ffmpeg-location`.

- Info: `... -J -i --flat-playlist -- <url>`. JSON is the first stdout line starting with `{`.
- Download (all modes): `--windows-filenames --trim-filenames <60..200> -P home:<outDir> -P temp:<tempDir> --newline --progress --progress-template "download:KEEPSAKE|status|downloaded|total|estimate|speed|eta|playlist_index|n_entries|filename" --progress-template "postprocess:KEEPSAKE_PP|status|postprocessor" --print "after_move:KEEPSAKE_DONE|%(filepath)s" -i --retries 10 --fragment-retries 10 --socket-timeout 30 --concurrent-fragments 4 --no-playlist`
  - Output template (all modes): `-o "%(title).80B [%(id)s].%(ext)s"`.
  - Video: `-o "%(title).80B [%(id)s].%(ext)s" -f "bestvideo[height<=N]+bestaudio/best[height<=N]/best" [-S res,fps,vcodec:h264,acodec:aac] --merge-output-format mp4/mkv [--embed-thumbnail --convert-thumbnails jpg --embed-metadata]` (bracketed embeds only when `embedVideoMeta === true`). Picked video-only stream: `-f "<id>+bestaudio[ext=m4a]/<id>+bestaudio"`.
  - Audio M4A, info lists a native m4a audio-only stream (not a playlist): `-o "%(title).80B [%(id)s].%(ext)s" -f "bestaudio[ext=m4a]"`, **no `-x`** (no ExtractAudio pass). yt-dlp may still run its `FixupM4a` step for DASH m4a; that is a stream copy.
  - Audio M4A otherwise: `-f "bestaudio[ext=m4a]/bestaudio/best" -x --audio-format m4a`.
  - Audio OPUS: `-f "bestaudio[acodec=opus]/bestaudio/best" -x --audio-format opus --audio-quality <kbps>K`.
  - Audio MP3/WAV/FLAC: `-f bestaudio/best -x --audio-format <fmt>`, plus `--audio-quality <kbps>K` for MP3 (default 192).
  - Audio, all: `[--embed-thumbnail --convert-thumbnails jpg]` for MP3/M4A unless `embedThumbnail === false`, then `--embed-metadata`.
  - Thumbnail: `--skip-download --write-thumbnail -o "thumbnail:%(title)s_thumb.%(ext)s" [--convert-thumbnails png|jpg] --print "after_video:KEEPSAKE_DONE|%(thumbnails.-1.filepath)s"`.
- Last: `-- <url>`.

Never sent: `--remux-video`, `--recode-video`, `--postprocessor-args`, anything naming ffprobe. Unit tests: `src/engine/__tests__/ytdlp-args.test.ts`.

## 5. Config this contract depends on

- `@tauri-apps/plugin-http` + `tauri-plugin-http`; capability `http:default` allowing the YouTube, `youtubei.googleapis.com`, `*.googlevideo.com`, `*.ytimg.com`, `*.ggpht.com` and `*.googleusercontent.com` hosts (exact list in `src-tauri/capabilities/*.json`), desktop thumbnails of other sites are fetched by yt-dlp, not by the webview, so no wildcard host is allowed. No jsDelivr: nothing is loaded from a CDN at runtime.
- `@tauri-apps/plugin-fs` + `tauri-plugin-fs`, Android capability: `fs:allow-open`, `fs:allow-write`, `fs:allow-write-file`, `fs:allow-mkdir`, `fs:allow-exists`, `fs:allow-remove`, scope `$DOWNLOAD/**`, the app cache folder (transcode temp files), plus any user-picked folder.
- `keepsake-media:allow-transcode` in the Android capability (section 3).
- CSP `script-src 'self' 'unsafe-eval'`: youtubei.js's decipher uses `new Function`. `'wasm-unsafe-eval'` is no longer needed (ffmpeg.wasm is gone).

## 6. Android save modes and publish commands (Gallery, folder)

Android only; desktop ignores all of this. `androidSaveMode(settings)` in `src/engine/android-gallery.ts` resolves the mode:

| Order | Condition | Mode | Behaviour |
|---|---|---|---|
| 1 | `saveTreeUri` non-empty | `folder` | Saved into the user-picked SAF tree |
| 2 | else `saveDir` empty | `gallery` | MediaStore: Movies/Keepsake, Music/Keepsake or Pictures/Keepsake (collection chosen by MIME). **Default on Android.** |
| 3 | else | `legacy` | Existing app/preset folder flow, unchanged |

The tree wins over a legacy `saveDir`. Settings fields: `saveTreeUri`, `saveTreeName` (both default `""`).

Gallery and folder modes stage output in `$APPCACHE/gallery-<jobId>/`; the single-file, mux and transcode steps run unchanged there, then publish runs. The staging file is deleted only after a successful publish. The result `filePath` becomes the `content://` URI when published; open it through the plugin (`openFile` accepts `content://` via `checkedDocUri`), not the opener.

```ts
invoke<{ uri: string; displayPath: string; bytes: number }>("plugin:keepsake-media|gallery_publish",
  { src, kind: "video" | "audio" | "image", fileName, mime })
invoke<{ uri: string | null; name: string | null }>("plugin:keepsake-media|folder_pick", { initialUri? })
invoke<{ ok: boolean; name: string | null }>("plugin:keepsake-media|folder_status", { treeUri })
invoke<{ uri: string; name: string; bytes: number }>("plugin:keepsake-media|folder_save",
  { src, treeUri, fileName, mime })
```
- `gallery_publish`: API 29+ inserts with `IS_PENDING=1`, copies, clears the flag, reads back `DISPLAY_NAME` (MediaStore may rename); on error the row is deleted. API 24-28 needs `WRITE_EXTERNAL_STORAGE` (runtime, asked on the first gallery save only, never at launch), copies to a `.part`, renames, then scans. A free-space check runs first.
- `folder_pick`: `ACTION_OPEN_DOCUMENT_TREE`, takes a persistable READ|WRITE grant and releases older tree grants. `folder_status` checks the grant still exists. `folder_save` creates the document, copies in 64 KiB chunks, deletes only the half-written document on error and deletes `src` on success.
- Capabilities: `keepsake-media:allow-gallery-publish`, `allow-folder-pick`, `allow-folder-status`, `allow-folder-save`.
- Manifest: `WRITE_EXTERNAL_STORAGE` with `maxSdkVersion="28"` only. No `READ_MEDIA_*`, `MANAGE_EXTERNAL_STORAGE` or `POST_NOTIFICATIONS`.

### Errors
- Gallery: `gallery:<code>: <msg> kept=<path>`, codes `no_space`, `permission`, `unknown`. On failure the file is moved to `getExternalFilesDir(DOWNLOADS)` and `kept=` is that path (if the move also fails, the staging file is kept and the message says so). A publish failure with a kept file does **not** mark the download failed; the kept path is shown in the error detail and a toast is shown. Denied permission sends the file to the kept folder; permanently denied offers "Open settings" once.
- Folder: `folder:<code>: <msg>`, codes `permission`, `not_found`, `no_space`, `source_missing`, `bad_uri`, `io`.
- TS searches for the markers because Tauri may wrap the text. Rust validators: `content://` only, at most 2048 chars, no NUL or whitespace in tree URIs.
- Tests: `src/engine/__tests__/android-gallery.test.ts`, `android-folder.test.ts`.
