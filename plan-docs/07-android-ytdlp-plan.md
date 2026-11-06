# 07 - Android yt-dlp (TikTok + Instagram) via Chaquopy

Status: CONTRACT FROZEN. Author: master architect. Readers: S1-S5 (Sonnet engineers) and the master integration pass.
Nothing is built locally. GitHub Actions (`.github/workflows/build.yml`) is the only test. Write code that is right
by reading; every guess you make must be listed in your report.

## 0. Goal and non-goals in one paragraph

The Android APK downloads TikTok and Instagram video from a pasted link by running yt-dlp (PyPI, Unlicense) inside
the app through Chaquopy (MIT). YouTube on Android does not change (youtubei.js path, 360p progressive, M4A/WAV).
No ffmpeg on Android: no merge, no MP3/FLAC/Opus. TikTok/Instagram audio = M4A only. Build is arm64-v8a only.

### 0.1 Decisions where this plan deliberately differs from the brief (read these first)

1. **Chaquopy is applied to the plugin library module, not the generated app module.**
   The Kotlin that calls Python lives in `src-tauri/plugins/keepsake-media/android` (a `com.android.library`).
   If Chaquopy were applied to `gen/android/app`, the library could not compile against `com.chaquo.python.*`
   (no public compile artifact; the Gradle plugin injects the runtime into the module it is applied to).
   Chaquopy officially supports library modules (one module per app). So the `chaquopy { }` block, the
   `id("com.chaquo.python")` and `ndk.abiFilters` go into the **committed** file
   `src-tauri/plugins/keepsake-media/android/build.gradle.kts` (owned by S2). The generated app module is NOT touched.
   Bonus: AGP refuses `ndk.abiFilters` in the app together with Tauri's per-ABI product flavors / splits, so not
   touching the app avoids that conflict.
2. **Root Gradle patch uses the buildscript classpath, not `plugins { ... apply false }`.**
   Tauri CLI 2.12 writes `gen/android/build.gradle.kts` with a `buildscript { dependencies { classpath(...) } }`
   block and `settings.gradle` has no `pluginManagement` (so a `plugins { id(...) version ... }` lookup would hit only
   the Gradle Plugin Portal, where Chaquopy is not published). The script inserts
   `classpath("com.chaquo.python:gradle:17.2.0")` (Maven Central; verified the artifact exists). A `plugins {}`
   fallback is specified in section 6 in case the template changes.
3. **No info cache on the native side.** `ytdlp_download` re-runs extraction (`extract_info(url, download=True)`).
   TikTok format URLs need the cookies set during extraction inside the same `YoutubeDL` instance; replaying a cached
   info dict in a fresh instance gives HTTP 403. Cost: one extra page request (about 1 s).
4. **Progress events are OUT of scope for this MVP.** The Android path shows an indeterminate bar
   (`status: "downloading"`, `percent: undefined`). Reason: mobile `trigger()` events reach JS only through
   `addPluginListener` + the plugin's `registerListener` command and its permission; that wiring cannot be verified
   without a device, and a wrong guess breaks nothing visible but costs a CI round. Round 2 plan in section 11.
5. **`buildPython` is not set.** Chaquopy auto-detects `python3.12` then `python3` on Linux (and `py -3.12` on
   Windows), which works on CI (setup-python), in Docker (Ubuntu 24.04 python3 = 3.12) and on dev machines. If the
   CI log says it cannot find Python, S1/S2 add `buildPython("python3.12")` (section 9, risk R2).
6. A tiny Python module `keepsake_ytdlp.py` is shipped (S2). Kotlin calls two functions that take strings and return
   one JSON string. This keeps all PyObject juggling out of Kotlin and makes errors a plain `{code, message}`.

## 1. Architecture

```
 React UI (AddLink / FormatPicker / queue)
   |
   |  fetchInfo(url) / listFormats(info) / startDownload(req)          src/engine/index.ts, formats.ts, download.ts (S4)
   v
 src/engine/android-ytdlp.ts  (S5)
   isAndroidYtdlpSupported(url)  host allow-list, https only, platform()==="android"
   fetchAndroidInfo(url, signal) ----invoke("plugin:keepsake-media|ytdlp_info", {url})----------------+
   downloadAndroid(args)        ----invoke("plugin:keepsake-media|ytdlp_download", {url, formatId,     |
                                          outDir, fileName?})                                           |
   mapYtdlpError(msg) -> AppError                                                                       |
   ytdlpInfoToVideoInfo / pickYtdlpFormat (pure)                                                        |
                                                                                                        v
 Rust: tauri-plugin-keepsake-media  src-tauri/plugins/keepsake-media/src/lib.rs (S3)
   #[tauri::command] ytdlp_info(url)                      validate https + host allow-list
   #[tauri::command] ytdlp_download(url, format_id, out_dir, file_name?)   validate url, format_id, out_dir, file_name
   run_mobile_plugin_async("ytdlpInfo" | "ytdlpDownload", args)   (non-Android: Err)
                                                                                                        |
                                                                                                        v
 Kotlin: app.keepsake.media.KeepsakeMediaPlugin (S2)
   @Command ytdlpInfo(invoke) / @Command ytdlpDownload(invoke)
     parseArgs -> KeepsakeYtdlp.executor (single thread) -> checkedPath(outDir) -> KeepsakeYtdlp.info/download
     resolve(JSObject) | reject("ytdlp:<code>: <message>")
 Kotlin: app.keepsake.media.KeepsakeYtdlp (S2, new)
   lazy, once: if (!Python.isStarted()) Python.start(AndroidPlatform(appContext))
   Python.getInstance().getModule("keepsake_ytdlp").callAttr("info" | "download", ...) -> JSON String
                                                                                                        |
                                                                                                        v
 Python 3.12 (Chaquopy 17.2.0): src-tauri/plugins/keepsake-media/android/src/main/python/keepsake_ytdlp.py (S2)
   builds YoutubeDL options ONLY from the allow-list (section 2.5), never raises, returns JSON
                                                                                                        |
                                                                                                        v
 yt_dlp (PyPI yt-dlp==2026.10.26, pure Python) + certifi==2026.10.23 -> HTTPS to tiktok.com / instagram.com CDNs
   writes <outDir>/<fileName>.<ext>.part, renames to <fileName>.<ext> on success (yt-dlp default behaviour)
```

YouTube on Android keeps the existing path (`youtube.ts` + plugin-http + plugin-fs + `transcode`). Desktop is unchanged.

## 2. Binding contract

### 2.1 Names

| Layer | Info | Download |
|---|---|---|
| TS invoke | `"plugin:keepsake-media\|ytdlp_info"` | `"plugin:keepsake-media\|ytdlp_download"` |
| Rust command fn | `ytdlp_info` | `ytdlp_download` |
| build.rs COMMANDS | `"ytdlp_info"` | `"ytdlp_download"` |
| Permission (auto-generated) | `allow-ytdlp-info` | `allow-ytdlp-download` |
| Capability entry | `keepsake-media:allow-ytdlp-info` | `keepsake-media:allow-ytdlp-download` |
| Rust -> Kotlin method | `"ytdlpInfo"` | `"ytdlpDownload"` |
| Kotlin @Command | `fun ytdlpInfo(invoke: Invoke)` | `fun ytdlpDownload(invoke: Invoke)` |
| Kotlin @InvokeArg class | `YtdlpInfoArgs` | `YtdlpDownloadArgs` |
| Python function | `keepsake_ytdlp.info(url)` | `keepsake_ytdlp.download(url, format_id, out_dir, file_name)` |

### 2.2 `ytdlp_info`

JS args: `{ url: string }`.

Resolves (JSON keys exactly as below; snake_case inside `info`, matching yt-dlp naming):

```ts
interface YtdlpInfoResponse { ok: true; info: YtdlpInfo }
interface YtdlpInfo {
  id: string;                 // never empty; Python falls back to ""
  title: string;              // Python falls back to "Untitled"
  uploader: string | null;    // uploader, else channel, else null
  duration: number | null;    // seconds (float allowed)
  thumbnail: string | null;   // info["thumbnail"], else last entry of info["thumbnails"] with a url, else null
  extractor: string;          // info["extractor_key"] or info["extractor"], e.g. "TikTok", "Instagram"
  webpage_url: string;        // info["webpage_url"], else the input url
  formats: YtdlpFormat[];     // same order as yt-dlp (worst first)
}
interface YtdlpFormat {
  format_id: string;
  ext: string;                // "" when missing
  vcodec: string | null;      // "none" means no video; null means unknown
  acodec: string | null;      // "none" means no audio; null means unknown
  height: number | null;      // int
  fps: number | null;         // float  (added to the brief's list: needed for picker labels)
  filesize: number | null;    // int: filesize, else filesize_approx, else null
  protocol: string;           // "https", "http", "m3u8_native", ... ("" when missing)
  format_note: string | null; // added: TikTok marks the watermarked format here
}
```

`url`, `http_headers`, `cookies`, `fragments` and every other key are NOT sent to JS.

Rejects with a string containing `ytdlp:<code>: <message>` (section 2.4).

### 2.3 `ytdlp_download`

JS args: `{ url: string; formatId: string; outDir: string; fileName?: string }`.

- `url`: the `webpage_url` from info (or the pasted URL). Same validation as info.
- `formatId`: ONE concrete yt-dlp `format_id` taken from `info.formats` (not a selector expression).
  Allowed characters: `A-Z a-z 0-9 _ - .`, length 1..=64. Rust rejects anything else.
- `outDir`: absolute POSIX path, no `..` component. Kotlin re-checks it is inside `allowedRoots()` (the existing
  `checkedPath`) and creates it with `mkdirs()` if missing.
- `fileName`: optional base name WITHOUT extension. 1..=200 chars, no `/`, `\`, NUL, not starting with `.`.
  TS always sends it (a unique, `safeName`-cleaned base from `uniquePath`). When absent, Python uses
  `%(title).80B [%(id)s].%(ext)s`.

Resolves: `{ path: string; bytes: number }` (absolute path of the finished file, size in bytes from `os.path.getsize`).

The file is written by yt-dlp as `<name>.<ext>.part` and renamed on success (yt-dlp default; `nopart` stays False).
On any failure Python deletes `<outDir>/<fileName>.*.part` it created (only when `fileName` was given).

Rejects with `ytdlp:<code>: <message>`.

### 2.4 Error format and codes

Every rejection that originates in Rust, Kotlin or Python is ONE string: `ytdlp:<code>: <human message>`.
`<code>` is exactly one of:

| code | Python classification (first match wins, case-insensitive on `str(exc)`) | AppErrorCode in TS |
|---|---|---|
| `unsupported_url` | `"unsupported url"`, `"is not a valid url"`, playlist/multi-item result, Rust host/scheme rejection | `unsupported_url` |
| `login_required` | `"login"`, `"log in"`, `"sign in"`, `"cookies"`, `"private"`, `"authentication"`, `"not available for anonymous"` | `login_required` |
| `rate_limited` | `"429"`, `"too many requests"`, `"rate-limit"`, `"rate limit"` | `rate_limited` |
| `forbidden` | `"403"`, `"forbidden"` | `forbidden` |
| `not_found` | `"404"`, `"not found"`, `"video unavailable"`, `"no longer available"`, `"has been removed"` | `not_found` |
| `parse_failed` | `"unable to extract"`, `"unable to parse"`, `"jsondecodeerror"`, `"no video formats"`, `"no formats"` | `parse_failed` |
| `network` | exception is `OSError`/`socket.timeout`/`urllib.error.URLError` (or `yt_dlp.networking.exceptions.TransportError`), or text has `"getaddrinfo"`, `"timed out"`, `"connection"`, `"network is unreachable"`, `"name resolution"`, `"ssl"` | `network` |
| `unknown` | everything else, including file > 500 MiB, Rust argument validation, Kotlin exceptions | `unknown` |

Order of the checks in Python = the table order. The `<message>` is `yt_dlp.utils`-cleaned text: strip ANSI,
strip a leading `ERROR: `, max 300 chars. Never include cookies or full CDN URLs (truncate at 300 chars is enough;
yt-dlp error texts rarely include signed URLs).

Tauri may wrap the Kotlin/Rust text (e.g. add a prefix). Therefore TS must search, not anchor:
`/ytdlp:([a-z_]+):\s*([\s\S]*)/`.

### 2.5 Python options (allow-list; nothing else may be set)

Common to info and download:

```python
BASE = {
    "noplaylist": True,
    "quiet": True,
    "no_warnings": False,        # warnings go to stderr -> logcat (tag python.stderr)
    "retries": 5,
    "fragment_retries": 5,
    "socket_timeout": 30,
    "restrictfilenames": False,
    "extract_flat": False,
    "cachedir": False,           # added: no ~/.cache writes on Android
    "noprogress": True,          # added: no progress bar lines (no progress events this round)
}
```

`no_config`: yt-dlp's Python API never reads config files (only the CLI does), and `no_config` is not a valid
`YoutubeDL` param key in current releases; do NOT pass it. Recorded here so nobody adds it back.

Download adds:

```python
opts = dict(BASE)
opts.update({
    "format": format_id,                                    # the concrete id, verbatim
    "paths": {"home": out_dir, "temp": out_dir},
    "outtmpl": {"default": os.path.join(out_dir, name_tmpl)},
    "max_filesize": 500 * 1024 * 1024,
    "overwrites": False,
})
# name_tmpl = file_name.replace("%", "%%") + ".%(ext)s"   when file_name is given
# name_tmpl = "%(title).80B [%(id)s].%(ext)s"             otherwise
```

Forbidden: `postprocessors`, `ffmpeg_location`, `merge_output_format`, `cookiefile`, `cookiesfrombrowser`, `proxy`,
`username`, `password`, `external_downloader`, `exec`, any key derived from user input other than `format`,
`outtmpl`, `paths`. Cancellation (a progress_hook raising) is OUT of scope this round.

### 2.6 Python module `keepsake_ytdlp.py` (S2)

```python
def info(url: str) -> str
    # with yt_dlp.YoutubeDL(BASE) as ydl: raw = ydl.extract_info(url, download=False)
    # raw = ydl.sanitize_info(raw)
    # if raw.get("_type") in ("playlist", "multi_video"): -> error unsupported_url
    #     "Posts with several videos are not supported on Android yet."
    # return json.dumps({"ok": True, "info": reduce(raw)}, ensure_ascii=False)

def download(url: str, format_id: str, out_dir: str, file_name) -> str   # file_name: str or None
    # with yt_dlp.YoutubeDL(opts) as ydl: res = ydl.extract_info(url, download=True)
    # playlist check as above
    # path = (res.get("requested_downloads") or [{}])[0].get("filepath")
    # if not path or not os.path.isfile(path):
    #     size = res.get("filesize") or res.get("filesize_approx")
    #     -> error unknown, "The file is larger than the 500 MiB limit on Android." if size and size > limit
    #        else "yt-dlp finished without writing a file."
    # real = os.path.realpath(path); must start with os.path.realpath(out_dir) + os.sep, else error unknown
    # return json.dumps({"ok": True, "path": real, "bytes": os.path.getsize(real)})

# Errors: both functions catch BaseException (incl. KeyboardInterrupt, SystemExit) and return
#   json.dumps({"ok": False, "code": <code from 2.4>, "message": <cleaned text>})
# They never raise.
```

### 2.7 Kotlin (S2)

```kotlin
@InvokeArg class YtdlpInfoArgs { lateinit var url: String }
@InvokeArg class YtdlpDownloadArgs {
  lateinit var url: String
  lateinit var formatId: String
  lateinit var outDir: String
  var fileName: String? = null
}

// KeepsakeYtdlp.kt
internal class YtdlpError(val code: String, message: String) : Exception(message)
internal object KeepsakeYtdlp {
  val CODES = setOf("unsupported_url","login_required","rate_limited","forbidden","not_found","parse_failed","network","unknown")
  val executor: ExecutorService = Executors.newSingleThreadExecutor()  // ALL Python calls run here
  /** Runs on executor only. Starts Python once. */
  private fun module(context: Context): PyObject {
    if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
    return Python.getInstance().getModule("keepsake_ytdlp")
  }
  /** Blocking; call on executor. Returns the parsed {"ok":true,...} object or throws YtdlpError. */
  fun info(context: Context, url: String): JSONObject
  fun download(context: Context, url: String, formatId: String, outDir: String, fileName: String?): JSONObject
}
```

- `info`: `module(ctx).callAttr("info", url).toString()` -> `JSONObject(s)`; if `ok` is false throw
  `YtdlpError(code if in CODES else "unknown", message)`.
- `download`: `callAttr("download", url, formatId, outDir, fileName)` (Kotlin `null` becomes Python `None`).
- Plugin commands:
  ```kotlin
  @Command fun ytdlpInfo(invoke: Invoke) {
    val args = try { invoke.parseArgs(YtdlpInfoArgs::class.java) } catch (e: Exception) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_info arguments: ${e.message}"); return }
    KeepsakeYtdlp.executor.execute {
      try {
        val r = KeepsakeYtdlp.info(activity, args.url)
        invoke.resolve(JSObject(r.toString()))           // {"ok":true,"info":{...}}
      } catch (e: YtdlpError) { invoke.reject("ytdlp:${e.code}: ${e.message}") }
        catch (e: Throwable) { invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}") }
    }
  }
  ```
  `ytdlpDownload` is the same shape, plus `val dir = checkedPath(args.outDir, "output folder")` and
  `if (!dir.isDirectory && !dir.mkdirs()) reject("ytdlp:unknown: Can't create folder ...")` BEFORE calling Python,
  passing `dir.path`. Resolve `JSObject().put("path", r.getString("path")).put("bytes", r.getLong("bytes"))`.
  A `MediaError` from `checkedPath` is rejected as `ytdlp:unknown: <message>`.
- Kotlin does NOT re-validate hosts.
- The existing `worker` pool (transcode) is untouched. Downloads through yt-dlp run one at a time (single thread);
  a second job waits. This is intended for the MVP.

### 2.8 Rust (S3)

```rust
pub const YTDLP_HOSTS: &[&str] = &["tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "instagram.com", "instagr.am"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpFormat { format_id: String, ext: String, vcodec: Option<String>, acodec: Option<String>,
    height: Option<u32>, fps: Option<f64>, filesize: Option<u64>, protocol: String, format_note: Option<String> }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpInfo { id: String, title: String, uploader: Option<String>, duration: Option<f64>,
    thumbnail: Option<String>, extractor: String, webpage_url: String, formats: Vec<YtdlpFormat> }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpInfoResponse { ok: bool, info: YtdlpInfo }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpDownloadResponse { path: String, bytes: u64 }

#[derive(Debug, Serialize)] struct YtdlpInfoArgs { url: String }
#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
struct YtdlpDownloadArgs { url: String, format_id: String, out_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")] file_name: Option<String> }

#[tauri::command] async fn ytdlp_info<R: Runtime>(app: AppHandle<R>, url: String) -> Result<YtdlpInfoResponse, String>
#[tauri::command] async fn ytdlp_download<R: Runtime>(app: AppHandle<R>, url: String, format_id: String,
    out_dir: String, file_name: Option<String>) -> Result<YtdlpDownloadResponse, String>
```

(Field visibility: make the struct fields `pub` if clippy/unused warnings appear; not required.)

Validation functions (pure, unit-tested, no `regex` crate, no new dependencies; use `tauri::Url`):

- `fn validate_ytdlp_url(raw: &str) -> Result<(), String>`: parse with `tauri::Url::parse`; scheme must be `https`;
  host (lower-cased, trailing `.` stripped) must equal a `YTDLP_HOSTS` entry or end with `"." + entry`.
  Error: `ytdlp:unsupported_url: Only https TikTok and Instagram links are supported on Android: <raw>`.
- `fn validate_format_id(s: &str)`: 1..=64 chars, each `is_ascii_alphanumeric() || "_-.".contains(c)`.
  Error: `ytdlp:unknown: Invalid format id: <s:?>`.
- `fn validate_out_dir(s: &str)`: starts with `/`, no `Component::ParentDir`. Error `ytdlp:unknown: ...`.
- `fn validate_file_name(s: &str)`: 1..=200 chars, no `/` `\` `\0`, not starting with `.`. Error `ytdlp:unknown: ...`.
- Native call errors: `.map_err(|e| e.to_string())` (same as transcode). Non-Android builds return
  `Err("ytdlp:unknown: yt-dlp through keepsake-media is only available on Android.".into())`.
- Register both in `generate_handler![transcode, open_file, ytdlp_info, ytdlp_download]`.
- Update the crate doc comment at the top of lib.rs to list the two new commands.

### 2.9 TypeScript module `src/engine/android-ytdlp.ts` (S5)

Exact exports (names and signatures are binding; S4 codes against them):

```ts
import type { AppError, VideoInfo } from "../lib/types";

/** Hosts served by yt-dlp on Android. Exact host or any subdomain; https only. */
export const ANDROID_YTDLP_HOSTS: readonly string[] =
  ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "instagram.com", "instagr.am"] as const;

export const YTDLP_ERROR_CODES: readonly string[] =
  ["unsupported_url", "login_required", "rate_limited", "forbidden", "not_found", "parse_failed", "network", "unknown"];

export interface YtdlpFormat { format_id: string; ext: string; vcodec: string | null; acodec: string | null;
  height: number | null; fps: number | null; filesize: number | null; protocol: string; format_note: string | null; }
export interface YtdlpInfo { id: string; title: string; uploader: string | null; duration: number | null;
  thumbnail: string | null; extractor: string; webpage_url: string; formats: YtdlpFormat[]; }

/** Pure host check (no platform check): https + allow-listed host. Used by tests and index.ts. */
export function isAndroidYtdlpHost(url: string): boolean;
/** platform() === "android" && isAndroidYtdlpHost(url). */
export function isAndroidYtdlpSupported(url: string): boolean;

/** Pure: reduced yt-dlp info -> VideoInfo (source "ytdlp"). Drops formats whose protocol is not http/https. */
export function ytdlpInfoToVideoInfo(info: YtdlpInfo, requestedUrl: string): VideoInfo;

export interface YtdlpPick { formatId: string; ext: string; needsRemux: boolean; height?: number; sizeBytes?: number }
/** Pure: UI formatId ("video:<h>" | "audio:m4a") -> concrete yt-dlp format, or null when nothing fits. */
export function pickYtdlpFormat(info: VideoInfo, uiFormatId: string): YtdlpPick | null;

/** Invokes ytdlp_info. Rejects with EngineError. Abort -> EngineError "cancelled" at once (native call keeps running, result dropped). */
export function fetchAndroidInfo(url: string, signal?: AbortSignal): Promise<VideoInfo>;

/** Invokes ytdlp_download. Rejects with EngineError. Validates the response shape. */
export function downloadAndroid(args: { url: string; formatId: string; outDir: string; fileName?: string }):
  Promise<{ path: string; bytes: number }>;

/** Any rejection text -> AppError. Never throws. */
export function mapYtdlpError(message: string): AppError;
```

Rules:

- `isAndroidYtdlpHost`: `new URL(url)` inside try; `protocol === "https:"`; host lower-cased, trailing dot removed;
  `h === d || h.endsWith("." + d)` for some `d` in `ANDROID_YTDLP_HOSTS`. `http://`, `tiktok.com.evil.com`,
  `nottiktok.com`, `instagram.com@evil.com` (host is evil.com) must all be false.
- `ytdlpInfoToVideoInfo`:
  - streams: from `formats` with `protocol` `https` or `http` only (drops m3u8/dash fragments; no ffmpeg to join
    them), excluding `vcodec === "none" && acodec === "none"`. `kind`: `vcodec === "none"` -> `audio-only`;
    `acodec === "none"` -> `video-only`; otherwise (including null/unknown) -> `progressive`.
    `id = format_id`, `ext = ext || "mp4"`, `height/fps/sizeBytes` from height/fps/filesize (null -> undefined),
    `vcodec/acodec` undefined when null or "none".
  - `heights` / `fpsByHeight`: from non-audio streams, same as `mapYdlInfo` in ytdlp.ts.
  - `id`, `url = webpage_url || requestedUrl`, `site = extractor.toLowerCase()` (e.g. `"tiktok"`, `"instagram"`),
    `kind = hasVideo ? "video" : "audio"` (`hasVideo` = any non-audio stream), `title || "Untitled"`,
    `channel = uploader ?? undefined`, `durationSec = duration ?? undefined`,
    `thumbnails = thumbnail ? [{ url: thumbnail }] : []`, `previewOnly: false`, `source: "ytdlp"`.
- `pickYtdlpFormat` (info must have `source === "ytdlp"`, else return null):
  - `video:<h>` (h a positive integer): candidates = progressive streams with `(height ?? 0) <= h`.
    Sort: height desc; then not watermarked first (a `format_note` is not in StreamInfo, so S5 keeps a module-level
    `WeakMap<VideoInfo, Set<string>>` of watermarked format_ids filled by `ytdlpInfoToVideoInfo` when
    `/watermark/i.test(format_note)`; also treat `format_id` matching `/^download/i` as watermarked); then
    H.264 first (`/^(avc|h264)/i.test(vcodec)`); then sizeBytes desc. Return the first:
    `{ formatId: id, ext, needsRemux: false, height, sizeBytes }`. `video:best` is treated as `video:100000`.
  - `audio:m4a`: (1) best audio-only stream with `ext === "m4a"` (largest sizeBytes, else last in list) ->
    `needsRemux: false, ext: "m4a"`; else (2) smallest progressive stream with `ext === "mp4"` whose acodec is
    undefined or matches `/^(mp4a|aac)/i` -> `needsRemux: true, ext: "mp4"` (the caller downloads to the app cache
    and remuxes with the existing `transcode` command, format `"m4a"`); else null.
  - anything else (`audio:mp3`, `audio:wav`, `thumb:*`, malformed) -> null.
- `mapYtdlpError(message)`:
  - match `/ytdlp:([a-z_]+):\s*([\s\S]*)/`. If matched and code in `YTDLP_ERROR_CODES`: return
    `{ code: <mapped AppErrorCode per table 2.4>, message: ANDROID_TEXT[code] + (detail ? " (Details: <detail, max 300>)" : ""), detail, cookiesHint: false }`.
  - Not matched and `/plugin\b.*\bnot (found|initialized|registered)|command\b.*\bnot found|unknown command|not allowed|denied/i`
    -> `{ code: "ytdlp_missing", message: "TikTok and Instagram downloads aren't available in this build. Reinstall Keepsake.", detail: message, cookiesHint: false }`.
  - Otherwise `{ code: "unknown", message: cleanError(message), detail: message, cookiesHint: false }`
    (`cleanError` from `./errors`).
  - `cookiesHint` is ALWAYS false on Android (there is no Settings > Cookies on Android). That is why this module
    uses its own texts instead of `ERROR_TEXT`:
    ```ts
    const ANDROID_TEXT = {
      unsupported_url: "This link isn't supported. Paste a TikTok or Instagram video link.",
      login_required: "This post needs a logged-in account, or the site is limiting anonymous access. Try again later or use the desktop app.",
      rate_limited: "The site is rate-limiting requests (HTTP 429). Wait a few minutes and try again.",
      forbidden: "The site refused access (HTTP 403). The post may be private or restricted.",
      not_found: "The post wasn't found. The link may be wrong or the video was removed.",
      parse_failed: "Couldn't read this page. The site may have changed; a Keepsake update may fix it.",
      network: "Couldn't reach the site. Check your internet connection and try again.",
      unknown: "The download failed.",
    };
    ```
- `fetchAndroidInfo`: if `!isAndroidYtdlpSupported(url)` throw `EngineError(appError("unsupported_url", url))`.
  If `signal?.aborted` -> `fail("cancelled")`. `Promise.race` of the invoke with an abort promise. Response must be
  an object with `ok === true` and `info` with string `id` and array `formats`, else
  `EngineError({ code: "parse_failed", message: ANDROID_TEXT.parse_failed, detail: "bad ytdlp_info response", cookiesHint: false })`.
  Any invoke rejection -> `throw new EngineError(mapYtdlpError(rawText(e)))`.
- `downloadAndroid`: invoke with `{ url, formatId, outDir, ...(fileName ? { fileName } : {}) }`. Response must have
  string `path` (non-empty) and finite number `bytes`, else `EngineError` code `unknown`. Rejections mapped as above.
- Imports allowed: `@tauri-apps/api/core` (`invoke`), `./errors` (`EngineError`, `appError`, `fail`, `cleanError`),
  `./platform` (`platform`), `../lib/types` (types only). It must NOT import download.ts, index.ts or formats.ts
  (formats.ts imports this module; no cycles).
- File header comment: same style as android-media.ts (contract + VERIFIED/INFERRED notes).

### 2.10 TypeScript routing (S4)

`src/engine/index.ts`, Android branch of `fetchInfoInner`:

```ts
if (p === "android") {
  if (yt) return fetchYouTubeInfo(url);
  if (isAndroidYtdlpHost(url)) return fetchAndroidInfo(url, opts.signal);
  fail("unsupported_url", "Only YouTube, TikTok and Instagram links work in the Android app. Other sites need the desktop app.");
}
```
(Uses `isAndroidYtdlpHost`, not `isAndroidYtdlpSupported`, because `p` is already android; either is correct.)
`binaryStatus()` is unchanged (Android stays `"unsupported"`).

`src/engine/download.ts`:

- In `startDownload.run`, before `return runDirect(...)`:
  `if (platform() === "android" && (isAndroidYtdlpSupported(req.url) || req.info?.source === "ytdlp")) return runAndroidYtdlp(req, emit, ctrl.signal);`
- Update the `runDirect` rejection text to: `"Only YouTube, TikTok and Instagram links can be downloaded on this device. Other sites need the desktop app."`
- New `async function runAndroidYtdlp(req, emit, signal): Promise<DownloadProgress>`:
  1. `const [kind] = req.formatId.split(":")`; `kind === "thumb"` -> `formatError("Thumbnails from TikTok and Instagram can be saved in the desktop app only.", req.formatId)`.
  2. `info = req.info?.source === "ytdlp" ? req.info : await fetchAndroidInfo(req.url, signal)`.
  3. `pick = pickYtdlpFormat(info, req.formatId)`; null -> `formatError("This format isn't available for this link on Android.", req.formatId)`.
  4. `emit({ id: req.id, status: "downloading", downloadedBytes: 0 })` (indeterminate; no percent).
  5. `!pick.needsRemux`: `dir = await androidOutDir(req)`; `target = await uniquePath(dir, safeName(info.title), pick.ext)`;
     `fileName` = basename of `target` without `"." + pick.ext` (string slice; `target` was built by `join`, so
     split on the last `/`). `{ path, bytes } = await downloadAndroid({ url: info.url, formatId: pick.formatId, outDir: dir, fileName })`.
     If `signal.aborted`: `await remove(path).catch(() => undefined)`; `fail("cancelled")`.
     Return `{ id, status: "done", downloadedBytes: bytes, totalBytes: bytes, percent: 100, filePath: path }`.
  6. `pick.needsRemux` (only for `audio:m4a`): `cache = await appCacheDir()`; `tmpDir = await join(cache, "ytdlp-" + safeName(req.id, 60))`;
     `mkdir(tmpDir, { recursive: true })`; download with `fileName: "source"` into `tmpDir`;
     if aborted -> cleanup + `fail("cancelled")`; `emit converting`; `out = await uniquePath(await androidOutDir(req), safeName(info.title), "m4a")`;
     `await transcodeAudio({ input: path, output: out, format: "m4a" })`; aborted -> remove out + cancelled;
     `finally { await remove(tmpDir, { recursive: true }).catch(() => undefined) }`.
     Return done with `filePath` = transcode result path, bytes = downloaded bytes.
- `cancel()` keeps working as today: the flag makes the final status `cancelled`; the native yt-dlp job is not
  interrupted (out of scope) and its output is deleted when it returns (steps 5/6).
- Update the top-of-file doc comment with the new Android branch.

`src/engine/formats.ts`: when `p === "android"` and `info?.source === "ytdlp"`:

- Video rows: distinct heights of `progressive` streams (no 360 cap), highest first, label `qualityLabel(h, fps)`,
  `ext: "mp4"`, `needsMerge: false`, `needsConversion: false`. Default: first height `<= 1080`, else the first.
  No heights but `hasVideo` -> one disabled placeholder `"No single-file video for this link"`.
- Audio rows: only M4A. `const pick = pickYtdlpFormat(info, "audio:m4a")`; row `audio:m4a`, `isDefault: true`,
  `needsConversion: !!pick?.needsRemux`, `disabledReason: pick ? undefined : "No AAC audio in this link"`.
- Thumbnail rows: none (empty array) for this case.
- Every other platform/source combination is byte-for-byte unchanged (existing `__tests__/formats.test.ts` must
  still pass untouched).
- Import `pickYtdlpFormat` from `./android-ytdlp`. Update the header comment.

`src/lib/types.ts`: NO type changes. Only the doc comment on `VideoInfo.source`:
`/** Which backend produced this info. "ytdlp" = desktop sidecar, or Chaquopy yt-dlp on Android (TikTok/Instagram). */`.
`ERROR_TEXT` is not changed (Android yt-dlp errors use `ANDROID_TEXT` in android-ytdlp.ts).

## 3. File ownership (each file has exactly one owner; touching anything else is a defect)

| Engineer | Files | New? |
|---|---|---|
| **S1** CI + Gradle | `.github/workflows/build.yml` | edit |
| | `scripts/android-patch-gradle.sh` | new |
| | `docker/android/build.sh` | edit (call the patch script) |
| | `docker/android/Dockerfile` | edit (install `python3` = 3.12 on Ubuntu 24.04, plus `python3-venv` only if needed) |
| **S2** Kotlin + Python | `src-tauri/plugins/keepsake-media/android/src/main/java/KeepsakeMediaPlugin.kt` | edit |
| | `src-tauri/plugins/keepsake-media/android/src/main/java/KeepsakeYtdlp.kt` | new |
| | `src-tauri/plugins/keepsake-media/android/src/main/python/keepsake_ytdlp.py` | new |
| | `src-tauri/plugins/keepsake-media/android/build.gradle.kts` | edit (Chaquopy) |
| | `src-tauri/plugins/keepsake-media/android/consumer-rules.pro` | edit (keep rules) |
| **S3** Rust + permissions | `src-tauri/plugins/keepsake-media/src/lib.rs` | edit |
| | `src-tauri/plugins/keepsake-media/build.rs` | edit |
| | `src-tauri/plugins/keepsake-media/permissions/default.toml` | edit |
| | `src-tauri/plugins/keepsake-media/Cargo.toml` | edit only the `description` text; NO new dependencies |
| | `src-tauri/capabilities/mobile.json` | edit |
| **S4** TS routing | `src/engine/index.ts`, `src/engine/download.ts`, `src/engine/formats.ts`, `src/lib/types.ts` | edit |
| **S5** TS module + tests + docs | `src/engine/android-ytdlp.ts` | new |
| | `src/engine/__tests__/android-ytdlp.test.ts` | new |
| | `src/engine/CONTRACT.md` | edit |
| | `README.md` (Android sections only) | edit |

Not owned by anyone this round (do not touch): `src-tauri/src/**`, `src-tauri/tauri*.conf.json`, `package.json`,
`bun.lock`, `src-tauri/Cargo.lock`, `scripts/binaries.lock.json`, UI under `src/components`, `src/pages`, `src/state`,
existing tests. Generated `src-tauri/plugins/keepsake-media/permissions/autogenerated/**` and `schemas/**` are
produced by the build; if they are committed in the repo, S3 lists them in the report and the master regenerates.

If you need a change in a file you do not own, put the exact diff in your report under "Requests to other owners".

## 4. Per-engineer instructions

### S1 - CI and Gradle

`scripts/android-patch-gradle.sh` (bash, `set -euo pipefail`, executable bit noted in report; CI calls it with
`bash` so the bit is not required):

```
usage: scripts/android-patch-gradle.sh [GEN_DIR]     default GEN_DIR=src-tauri/gen/android
CHAQUOPY_VERSION="17.2.0"
```
1. `ROOT="$GEN_DIR/build.gradle.kts"`; missing -> `echo "::error::..." >&2; exit 1`.
2. If `grep -q 'com.chaquo.python' "$ROOT"` -> already patched, skip to step 5 (idempotent; Docker restores a
   persisted gen/android).
3. If a line matches `classpath("com.android.tools.build:gradle:` -> insert right after it, same indentation:
   `classpath("com.chaquo.python:gradle:17.2.0")`. Also require `mavenCentral()` to appear in `$ROOT`
   (the buildscript repositories); if not, fail.
4. Else if a line matches `^plugins \{` -> insert after it `    id("com.chaquo.python") version "17.2.0" apply false`,
   and ensure `$GEN_DIR/settings.gradle` (or `.kts`, whichever exists) contains `pluginManagement`; if it does not,
   prepend exactly:
   `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }` and a blank line.
   Else (neither anchor) -> fail with a message that prints the first 40 lines of `$ROOT`.
5. Verify: `grep -q 'com.chaquo.python' "$ROOT"` or fail. Print `$ROOT` and the AGP line to the log
   (`echo "--- patched $ROOT ---"; cat "$ROOT"`).
6. Do NOT touch `$GEN_DIR/app/**`. (Chaquopy and abiFilters live in the plugin module, section 0.1.)

Use `sed -i` with a line-number insert (`awk`/`sed` both fine); after every edit re-grep to prove it applied.

`.github/workflows/build.yml`, android job only:
- After `actions/setup-java@v4`, add:
  ```yaml
  # Chaquopy compiles the app's Python with a build-machine Python of the same minor version (3.12).
  - uses: actions/setup-python@v5
    with:
      python-version: "3.12"
  ```
- After the `tauri android init` step, add:
  ```yaml
  - name: Patch Gradle for Chaquopy (fails if the patch does not apply)
    run: bash scripts/android-patch-gradle.sh src-tauri/gen/android
  ```
- Keep `--target aarch64 --split-per-abi`. Update the header comment line for android to mention
  "Chaquopy + yt-dlp (TikTok/Instagram)". Release job: no change. Other jobs: no change.
- Optional (allowed): in the APK size report, add one line noting that the APK now includes Python + yt-dlp.

`docker/android/build.sh`: after the gen/android restore-or-init block (so it also runs on a restored cache), add
`log "Patching Gradle for Chaquopy"; bash scripts/android-patch-gradle.sh "$GEN"` (define `GEN` before use; it
already exists right after that block). `docker/android/Dockerfile`: add `python3` to the apt package list
(Ubuntu 24.04 ships 3.12) and a comment in the pinned-tools header: `Python 3.12 (Ubuntu 24.04 python3, for Chaquopy)`.

### S2 - Kotlin + Python

`android/build.gradle.kts` becomes (keep everything that exists; additions marked):

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")                       // added; version comes from the root buildscript classpath
}
android {
    ...
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        ndk { abiFilters += listOf("arm64-v8a") } // added; Chaquopy requires explicit ABIs; 3.12 is 64-bit only
    }
    ...
}
chaquopy {                                        // added
    defaultConfig {
        version = "3.12"
        pip {
            install("yt-dlp==2026.10.26")
            install("certifi==2026.10.23")
        }
    }
}
```

PIN: `yt-dlp==2026.10.26` (latest stable on PyPI on 2026-11-15, verified by the master; requires Python >= 3.11).
Look it up again on https://pypi.org/project/yt-dlp/ ; if a newer stable (no `.dev`) exists use it and say so in the
report; if you cannot reach PyPI, keep 2026.10.26 (do NOT fall back to the binaries.lock 2026.08.19, it is older).
`certifi` gives yt-dlp a CA bundle independent of Android's store (pure Python). Do NOT install `yt-dlp[default]`
(pulls brotli/pycryptodomex native wheels; not needed for TikTok/Instagram). No `buildPython` line (section 0.1 #5).

`consumer-rules.pro` add:
```
-keep class app.keepsake.media.KeepsakeYtdlp { *; }
-keep class app.keepsake.media.YtdlpInfoArgs { *; }
-keep class app.keepsake.media.YtdlpDownloadArgs { *; }
-keep class com.chaquo.python.** { *; }
```

`keepsake_ytdlp.py`: implement section 2.5/2.6 exactly. Imports: `json`, `os`, `re`, `glob`, `yt_dlp`.
Python 3.12 syntax OK. Header comment: allow-list rationale + "never raises". Module-level constant
`MAX_FILESIZE = 500 * 1024 * 1024`. `reduce(raw)` builds the dict of section 2.2 with explicit `int()/float()`
casts guarded by `isinstance(x, (int, float))` (bools excluded). `_classify(exc)` implements table 2.4.
`_clean(text)`: strip `\x1b\[[0-9;]*[A-Za-z]`, drop everything up to the last `ERROR:`, collapse whitespace, cut to 300.

`KeepsakeYtdlp.kt` and the two commands: section 2.7. Imports: `com.chaquo.python.Python`,
`com.chaquo.python.PyObject`, `com.chaquo.python.android.AndroidPlatform`, `org.json.JSONObject`.
`KeepsakeMediaPlugin` header KDoc: add the two commands. Do not change `transcode`/`openFile` behaviour.
`checkedPath` is private in the plugin class: keep it there and call it from `ytdlpDownload` (do not move it).

### S3 - Rust + permissions

- `build.rs`: `const COMMANDS: &[&str] = &["transcode", "open_file", "ytdlp_info", "ytdlp_download"];`
- `permissions/default.toml`: permissions list `["allow-transcode", "allow-open-file", "allow-ytdlp-info", "allow-ytdlp-download"]`; description mentions yt-dlp for TikTok/Instagram.
- `lib.rs`: section 2.8. Unit tests (in the existing `mod tests`), at least:
  `https://www.tiktok.com/@a/video/1` ok; `https://vm.tiktok.com/ZM123/` ok; `https://www.instagram.com/reel/abc/` ok;
  `https://instagr.am/p/x` ok; `http://www.tiktok.com/...` err; `https://tiktok.com.evil.com/x` err;
  `https://nottiktok.com/x` err; `https://youtube.com/watch?v=x` err; `not a url` err;
  format id `bytevc1_1080p_123-0` ok, `dash-1+2` err, `""` err, 65 chars err;
  file name `My video [123]` ok, `../x` err, `a/b` err, `.hidden` err; out dir `/data/x` ok, `rel` err, `/a/../b` err.
- `capabilities/mobile.json`: add `"keepsake-media:allow-ytdlp-info"` and `"keepsake-media:allow-ytdlp-download"`
  after the two existing keepsake-media entries; change `description` to
  `"Main window on Android. No window-control or shell permissions; yt-dlp runs in-process (Chaquopy) for TikTok and Instagram only."`.
  Do NOT add TikTok/Instagram hosts to `http:default` (yt-dlp's network traffic is Python sockets, not plugin-http).
- `Cargo.toml`: description -> `"Keepsake Android: audio transcoding on platform codecs, and yt-dlp (Chaquopy) for TikTok/Instagram."`

### S4 - TS routing

Section 2.10. Keep `bun run typecheck` and `bun run lint` (oxlint) clean. No new dependencies. Do not edit
android-ytdlp.ts (S5); code against the signatures in 2.9. `remove(path, { recursive: true })` is from
`@tauri-apps/plugin-fs` (already imported in download.ts; add `recursive` usage only).

### S5 - TS module, tests, docs

- `android-ytdlp.ts`: section 2.9.
- `__tests__/android-ytdlp.test.ts`: same header as formats.test.ts (`// @ts-nocheck`, bun:test). Mock
  `../platform` (switchable `current`) and `@tauri-apps/api/core` (`invoke: mock(async (cmd, args) => ...)`,
  `isTauri: () => true`). Tests, at least:
  1. host allow-list: every true/false case listed for Rust in S3, plus `isAndroidYtdlpSupported` false on windows/web.
  2. `mapYtdlpError` for all 8 codes (prefixed text, and text wrapped like `"Error: ytdlp:forbidden: HTTP Error 403"`),
     `cookiesHint === false` always, missing-plugin text -> `ytdlp_missing`, random text -> `unknown`.
  3. `ytdlpInfoToVideoInfo` on a TikTok-like fixture (h264 + bytevc1 progressive, one `download_addr-0`
     watermarked, one m3u8 format) -> m3u8 dropped, site `"tiktok"`, source `"ytdlp"`, heights correct.
  4. `pickYtdlpFormat`: video picks the non-watermarked h264 at the requested height; Instagram-like fixture with
     DASH video-only + m4a audio-only + progressive: `audio:m4a` -> audio-only, `needsRemux false`; TikTok fixture
     `audio:m4a` -> progressive mp4, `needsRemux true`; `audio:mp3` -> null; `thumb:png` -> null.
  5. `fetchAndroidInfo` calls `invoke("plugin:keepsake-media|ytdlp_info", { url })` and maps the result; rejects
     with code `unsupported_url` for a YouTube URL without invoking; abort -> code `cancelled`.
  6. `downloadAndroid` passes `{ url, formatId, outDir, fileName }` with exactly those keys, omits `fileName`
     when undefined; bad response -> code `unknown`.
  7. `listFormats` (import `../formats` after the mocks) for an android + ytdlp-source info: video rows without a
     360 cap, audio rows `["audio:m4a"]` only, no thumbnail rows.
  Note: Bun's `mock.module` is process-wide; this file must mock `../platform` the same way formats.test.ts does
  (functions `platform`, `inTauri`, `isDesktop`) so both files can run in one `bun test`.
- `CONTRACT.md`: section 1.1 table: Android Info row "YouTube via youtubei.js; TikTok and Instagram via yt-dlp
  (Chaquopy, in-process); others `unsupported_url`"; Video row adds "TikTok/Instagram: any single-file height, no
  360 cap"; Audio row "TikTok/Instagram: M4A only"; Thumbnail row "TikTok/Instagram: not offered on Android"; cancel
  semantics: Android yt-dlp jobs are not interrupted, output deleted afterwards. Add a section documenting
  `ytdlp_info`/`ytdlp_download` (copy 2.2-2.4 condensed).
- `README.md` Android sections only (feature list line, platform table row at ~line 88, the comparison paragraph at
  ~line 102, build section): TikTok/Instagram on Android, M4A only, APK size "about 30-45 MB" (estimate; S1's CI size
  report replaces it later), Chaquopy (MIT) + yt-dlp (Unlicense) credits, and the local build step
  `bash scripts/android-patch-gradle.sh` after `bun run android:init` (needs Python 3.12 on PATH).

## 5. Acceptance criteria (checkable by reading)

S1
- [ ] `scripts/android-patch-gradle.sh` exists, starts with `#!/usr/bin/env bash` and `set -euo pipefail`.
- [ ] It exits non-zero when the root file is missing, when neither anchor exists, and when the post-check grep fails.
- [ ] Running it twice is a no-op the second time.
- [ ] It never writes under `$GEN_DIR/app`.
- [ ] build.yml android job has setup-python 3.12 BEFORE `tauri android init`, and the patch step AFTER it and BEFORE
      the build step; `--target aarch64` kept; release job untouched; YAML indentation consistent (2 spaces).
- [ ] docker build.sh calls the script on both the fresh-init and restored-cache paths; Dockerfile installs python3.

S2
- [ ] `ytdlpInfo`/`ytdlpDownload` exist with `@Command`; arg classes have `@InvokeArg`; names exactly as 2.1.
- [ ] Every Python call happens inside `KeepsakeYtdlp.executor.execute { }`; `Python.start` guarded by `isStarted()`.
- [ ] Every reject string starts with `ytdlp:` and a code from the 8-code list.
- [ ] `outDir` passes `checkedPath` before Python runs.
- [ ] Python: options built only from 2.5; no `postprocessors`/cookies/proxy keys anywhere in the file;
      both functions wrapped in `try/except BaseException`; JSON keys exactly 2.2/2.3.
- [ ] build.gradle.kts has the plugin id, `abiFilters` arm64-v8a, `version = "3.12"`, pinned pip installs.
- [ ] consumer-rules.pro keep rules present.

S3
- [ ] COMMANDS, default.toml, mobile.json all list both new commands with the exact identifiers in 2.1.
- [ ] Rust validates https + host allow-list (identical list to TS), format_id, out_dir, file_name before the native
      call; non-Android returns Err.
- [ ] `YtdlpDownloadArgs` serializes camelCase (`formatId`, `outDir`, `fileName`); `fileName` skipped when None.
- [ ] Unit tests from S3 list present. No new crates.

S4
- [ ] Android fetchInfo routes TikTok/Instagram to `fetchAndroidInfo`; YouTube unchanged; others rejected with the new text.
- [ ] `startDownload` routes TikTok/Instagram on Android to `runAndroidYtdlp`; `runDirect` unchanged except the text.
- [ ] `runAndroidYtdlp` always passes `fileName`, deletes output on cancel, cleans the temp dir in `finally`.
- [ ] formats.ts: only the android+ytdlp branch is new; existing formats tests unchanged and still valid by reading.
- [ ] types.ts: comment only.

S5
- [ ] All exports of 2.9 exist with those exact names/signatures; no import of download/index/formats.
- [ ] Single exported host constant `ANDROID_YTDLP_HOSTS`; `cookiesHint` false in every Android yt-dlp error.
- [ ] Test file covers items 1-7.
- [ ] CONTRACT.md and README Android text match this plan; no other README sections edited.

Every engineer's report: list of files changed, any guesses (marked INFERRED), and requests to other owners.

## 6. Master integration checks (after all five report)

1. Name grep: `ytdlp_info`, `ytdlp_download`, `ytdlpInfo`, `ytdlpDownload`, `allow-ytdlp-info`,
   `allow-ytdlp-download`, `keepsake_ytdlp` appear in exactly the expected files (TS invoke strings in
   android-ytdlp.ts only).
2. Host list identical in `android-ytdlp.ts` (`ANDROID_YTDLP_HOSTS`) and `lib.rs` (`YTDLP_HOSTS`).
3. JSON field names identical across Python `reduce()`, Rust `YtdlpInfo`/`YtdlpFormat`, TS `YtdlpInfo`/`YtdlpFormat`.
   Numeric types: Python casts height/filesize to int and fps/duration to float, so Rust `u32`/`u64`/`f64` deserialize.
4. Download arg keys: TS `{url, formatId, outDir, fileName}` -> Rust params `url, format_id, out_dir, file_name`
   (Tauri camelCase -> snake_case) -> Rust serialize camelCase -> Kotlin `YtdlpDownloadArgs` fields same names ->
   Python positional `(url, format_id, out_dir, file_name)`.
5. Error prefix: Python codes == Kotlin `CODES` == TS `YTDLP_ERROR_CODES` (8 entries each).
6. formats.ts `pickYtdlpFormat` usage matches download.ts usage (same UI ids).
7. Push to a branch; CI: `check` (typecheck, lint, bun test, cargo test) then `android`. Read the android log for
   the sections in 9.
8. Size: compare the APK size in the job summary with the previous run (expected +20-30 MB).
9. Device smoke test by the user (not CI): paste a public TikTok video link and a public Instagram reel link,
   download 720p (or highest) video and M4A; confirm files open via the existing "open" button; YouTube 360p still works.

## 7. Data flow example (TikTok)

1. Paste `https://www.tiktok.com/@user/video/7300000000000000000`.
2. `fetchInfo` -> android -> `isAndroidYtdlpHost` true -> `fetchAndroidInfo` -> Rust validates -> Kotlin executor ->
   Python start (first time: 2-6 s, stdlib extraction) -> `info()` -> JSON -> VideoInfo `{ site: "tiktok", source: "ytdlp", streams: [...] }`.
3. Picker: video rows 1080/720/540 (whatever TikTok offers), default 1080; audio `M4A` (needsConversion true).
4. Download `video:1080` -> `pickYtdlpFormat` -> `h264_1080p_...` -> `uniquePath(Download, "<title>", "mp4")` ->
   `downloadAndroid({ url, formatId: "h264_1080p_...", outDir: ".../Download", fileName: "<title>" })` ->
   yt-dlp writes `<title>.mp4.part` -> renames -> `{ path, bytes }` -> done.

## 8. Python/Chaquopy runtime notes (for S2)

- First `Python.start` extracts the stdlib and packages from the APK into app storage; only on first run after
  install/update. Do it on the executor, never on the main thread.
- stdout/stderr of Python go to logcat with tags `python.stdout`/`python.stderr`; that is our only debugging channel
  on a device (`adb logcat -s python.stderr`).
- yt-dlp needs no JS runtime for TikTok or Instagram (only YouTube needs one; YouTube does not use this path).
- No ffmpeg: never select formats that need merging; TS only ever passes ONE concrete `format_id` that is
  progressive (video) or audio-only m4a, and only `http/https` protocol formats.

## 9. Known risks and what the CI log will show

| # | Risk | What the log shows | Fix (owner) |
|---|---|---|---|
| R1 | Chaquopy 17.2.0 vs AGP 9.3.1 / KGP 2.2.10. Docs list AGP 7.3-9.5 as supported, so expected OK. | `Chaquopy requires Android Gradle plugin version ...` or a `NoSuchMethodError` in `com.chaquo.python` task during configuration | Bump to the newest 17.x on Maven Central (S1 script constant + nothing else) |
| R2 | buildPython not found / wrong minor | `Couldn't find Python 3.12` / `buildPython ... version mismatch` in `:keepsake-media:generateDebugPythonRequirements` (or Release) | setup-python step order (S1), or add `buildPython("python3.12")` (S2) |
| R3 | Plugin id not resolvable | `Plugin [id: 'com.chaquo.python'] was not found` while configuring `:tauri-plugin-keepsake-media` | Root patch did not apply or classpath missing; check the `--- patched` dump (S1) |
| R4 | Chaquopy in a library module conflicts with the app | `Chaquopy ... can only be used in one module` or missing Python assets at runtime | Should not happen (only our module uses it). If it does, fallback plan: apply Chaquopy to `gen/android/app` via the patch script and call Python from the plugin by reflection (round 2, master decides) |
| R5 | `abiFilters` conflict | `Conflicting configuration : 'arm64-v8a' in ndk abiFilters cannot be present when splits abi filters are set` | Only if someone patched the app module; the library-only abiFilters should not trigger it |
| R6 | pip wheels for arm64 | `No matching distribution found for yt-dlp==...` | yt-dlp and certifi are pure-Python (`py3-none-any`), so no arm64 wheel is needed; this error means a wrong pin or no network to PyPI |
| R7 | R8/minify strips classes in release | Device: `ClassNotFoundException app.keepsake.media.YtdlpDownloadArgs` or `com.chaquo.python...` | consumer-rules.pro (S2) |
| R8 | Kotlin compile: `Unresolved reference: chaquo` | `:tauri-plugin-keepsake-media:compileReleaseKotlin` | Plugin id missing in the library build file (S2) |
| R9 | Instagram anonymous extraction often fails (login wall / rate limit). TikTok occasionally needs a newer yt-dlp. | Device only: `ytdlp:login_required` / `ytdlp:parse_failed` | Expected; documented in README. Updating = bump the pin and rebuild (no in-app updater this round) |
| R10 | APK size grows ~20-30 MB (CPython 3.12 runtime + stdlib + yt-dlp) | Job summary size table | Accepted. Possible later: Chaquopy `extractPackages`/`pyc` tuning |
| R11 | Single-thread executor: parallel TikTok/IG jobs run one after another; UI shows the second as "downloading" with no progress | Device only | Accepted for MVP |
| R12 | Tauri wraps reject text | TS sees e.g. `"ytdlp:forbidden: ..."` inside a longer string | `mapYtdlpError` searches instead of anchoring (S5) |
| R13 | `tauri android init` template changes the root build file form | Script fails with "neither anchor" and prints the file | Update the script anchors (S1) |
| R14 | Preview thumbnails from TikTok/IG CDNs may refuse hot-linking | Device only: blank thumbnail in the preview card | Cosmetic; out of scope |
| R15 | Cargo auto-generated permission names | Build error `Permission keepsake-media:allow-ytdlp-info not found` | build.rs COMMANDS must contain the snake_case names; tauri-plugin generates `allow-ytdlp-info` from `ytdlp_info` (S3) |

## 10. Out of scope this round

- MP3/FLAC/Opus/WAV for TikTok/Instagram on Android (M4A only). WAV for YouTube stays as today.
- Any merge of separate video and audio streams (no ffmpeg on Android). No "Best available" row for TikTok/IG.
- Thumbnail downloads (the "thumbnail" mode) for TikTok/Instagram on Android.
- Cookies, login, proxies, any user-supplied yt-dlp option.
- Cancellation of a running yt-dlp job (the result is deleted after it finishes).
- Live progress events (indeterminate bar only).
- Sites other than TikTok and Instagram on Android, playlists, multi-video posts (carousels).
- In-app yt-dlp updates (bump the pin and rebuild).
- x86_64 / armeabi-v7a builds, Play Store packaging, release-job changes, signing changes.

## 11. Round 2 notes (not for this round)

- Progress: Kotlin `trigger("progress", JSObject{ jobId, percent, speed })` from a yt-dlp progress_hook (called on
  the executor thread); TS `addPluginListener("keepsake-media", "progress", cb)` from `@tauri-apps/api/core`, which
  needs the `registerListener` command allowed for the plugin. Verify the exact permission identifier first.
- Cancel: a `threading.Event` per job checked in the progress hook, raising `yt_dlp.utils.DownloadCancelled`.

CONTRACT FROZEN - plan-docs/07-android-ytdlp-plan.md
