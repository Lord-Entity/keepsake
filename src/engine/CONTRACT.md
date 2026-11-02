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
| Info | YouTube via youtubei.js, falling back to yt-dlp `-J`; other sites via yt-dlp | YouTube only (youtubei.js); other sites reject with `unsupported_url` | YouTube only; plain-browser fetches fail with `web_cors` |
| Video | Every height the link offers, plus "Best available"; yt-dlp merges video-only + audio | Progressive MP4 (video + audio in one file) **at or below 360p** only. No merging, no "Best available" | Same as Android |
| Audio | MP3 (default), M4A, OPUS, WAV, FLAC | **M4A (default) and WAV only.** MP3, FLAC and OPUS are not listed | None |
| Thumbnail | Original, PNG, JPG | Original, PNG, JPG | Original, PNG, JPG |
| Playlists | Yes, per-item progress | Rejected (`format_unavailable`: "Playlists can be downloaded in the desktop app only.") | Rejected |
| Downloads via | yt-dlp sidecar (`run_ytdlp`) | Range requests through plugin-http, streamed to disk with plugin-fs | Range requests into a Blob, then `<a download>` |
| Conversion via | ffmpeg sidecar, run by yt-dlp | `keepsake-media` Tauri plugin (section 3) | None |

The 360p cap on Android is because only the ANDROID client's itag 18 (360p progressive, AAC audio) downloads without a PO token. Android audio quality is therefore that stream's AAC (roughly 96 kbps, estimated).

### 1.2 Cancel semantics

- `handle.cancel()` is idempotent. After it, no further non-final `onProgress` calls are delivered and the final status is `cancelled` (error code `cancelled`), even if the work finished in the same tick.
- Desktop: `cancel()` sets the flag and sends `cancel_ytdlp`. Because a cancel sent before Rust registers the job is a no-op, `runYtdlp` checks the flag before invoking, re-sends `cancel_ytdlp` on the first output line and once more 500 ms after start. The yt-dlp process tree is killed and `.keepsake-tmp/<jobId>` is deleted by Rust. Cookie-fallback retries stop as soon as the flag is set.
- Android/web: `cancel()` aborts the `AbortSignal` that every Range request uses. Partial output and the temp file in the app cache are deleted. The native `transcode` call cannot be interrupted; a cancel during it is honoured as soon as it returns, and the converted output is then deleted.
- `fetchInfo`: aborting `opts.signal` rejects with `cancelled`; on desktop it also sends `cancel_ytdlp` for the `info-<UUID>` job.

## 2. Tauri commands (Rust, `src-tauri/src/ytdlp.rs`)

### `run_ytdlp`
```ts
invoke<number>("run_ytdlp", { jobId: string, args: string[], tempDir: string | null, onEvent: Channel<YtdlpEvent> })
type YtdlpEvent = { event: "stdout"; line: string } | { event: "stderr"; line: string };
```
- Spawns the `yt-dlp` sidecar with Rust's fixed flags prepended: `--ignore-config --no-plugin-dirs --no-js-runtimes [--js-runtimes <runtime>:<absolute path>] --ffmpeg-location <sidecar dir>`. TS never sends any of these.
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

Android has no sidecars (`tauri.android.conf.json` sets `"externalBin": []`).

### JS runtime and cookie fallback
- Rust picks the runtime: the bundled `qjs` sidecar (`--js-runtimes quickjs:<absolute path>`) when the file exists; otherwise a user-installed Node, looked up on PATH, then `%ProgramFiles%\nodejs`, `C:\Program Files\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`, `%NVM_SYMLINK%` (Windows) or `/usr/local/bin`, `/usr/bin` (Linux) (`--js-runtimes node:<absolute path>`). The Node fallback must keep working.
- Neither found + YouTube URL: `run_ytdlp` rejects with `js_runtime_missing: ...` (TS code `js_runtime_missing`). Neither found + other site: runs with no JS runtime.
- Bot check (`bot_check`) with Settings > Cookies "off": TS retries once per installed browser in the order edge, chrome, firefox, brave, chromium, opera, vivaldi with `--cookies-from-browser <b>`, stops at the first success (download result `note: "Retried with cookies from <Browser>"`), else returns `bot_check` (cookiesHint true). An explicit browser choice is never overridden. Applies to downloads and to yt-dlp info fetches. `cancelled`, `js_runtime_missing` and `ytdlp_missing` end the loop at once.

## 3. Android native plugin `keepsake-media` (`src-tauri/plugins/keepsake-media`)

Kotlin, written against the platform `MediaExtractor` / `MediaCodec` / `MediaMuxer` APIs only (no ffmpeg, no GPL code). TS wrapper: `src/engine/android-media.ts`, exporting `transcodeAudio(args)` and `isAndroidMediaAvailable()`.

```ts
invoke<{ path: string }>("plugin:keepsake-media|transcode", {
  input: string,          // absolute path of the downloaded file (temp file in the app cache)
  output: string,         // absolute path of the final file
  format: "wav" | "m4a",
  kbps?: number,          // reserved for future encoders; ignored by "wav" and "m4a"
})
```
- `m4a`: copy the AAC track into an MPEG-4 audio container (no re-encode; any video track is dropped). Used when the audio came from the 360p progressive MP4.
- `wav`: decode the audio track to 16-bit PCM and write a WAV header.
- Resolves `{ path }` (the written file). Rejects with a message on any failure; the wrapper maps "plugin not found / not allowed" to `format_unavailable` and everything else to `unknown`.
- Capability: `keepsake-media:allow-transcode` in `src-tauri/capabilities/mobile.json`.
- M4A from an audio-only AAC stream needs no plugin call: the file is saved as served.
- Not supported this round: MP3 (needs LAME), FLAC and Opus (encoder availability per API level unverified; Opus needs API 29, minSdk is 24). The engine rejects them with `format_unavailable` before any network work, and `listFormats` does not offer them.

## 4. Arguments TS sends (for reference and Rust tests)

Every call: `--encoding utf-8 --no-warnings [--cookies-from-browser <b>]`. Rust prepends its fixed flags (section 2), so TS never sends `--ignore-config`, `--no-plugin-dirs`, `--js-runtimes`, `--no-js-runtimes` or `--ffmpeg-location`.

- Info: `... -J -i --flat-playlist -- <url>`. JSON is the first stdout line starting with `{`.
- Download (all modes): `--windows-filenames --trim-filenames <60..200> -P home:<outDir> -P temp:<tempDir> --newline --progress --progress-template "download:KEEPSAKE|status|downloaded|total|estimate|speed|eta|playlist_index|n_entries|filename" --progress-template "postprocess:KEEPSAKE_PP|status|postprocessor" --print "after_move:KEEPSAKE_DONE|%(filepath)s" -i`
  - Video: `-o "%(title)s.%(ext)s" -f "bestvideo[height<=N]+bestaudio/best[height<=N]/best" [-S res,fps,vcodec:h264,acodec:aac] --merge-output-format mp4/mkv [--embed-thumbnail --convert-thumbnails jpg --embed-metadata]` (bracketed embeds only when `embedVideoMeta === true`). Picked video-only stream: `-f "<id>+bestaudio[ext=m4a]/<id>+bestaudio"`.
  - Audio M4A, info lists a native m4a audio-only stream (not a playlist): `-o "%(title)s.%(ext)s" -f "bestaudio[ext=m4a]"`, **no `-x`** (no ExtractAudio pass). yt-dlp may still run its `FixupM4a` step for DASH m4a; that is a stream copy.
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
