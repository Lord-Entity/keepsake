//! keepsake-media: Android audio transcoding for Keepsake.
//!
//! The work happens in the Kotlin class `app.keepsake.media.KeepsakeMediaPlugin`
//! (android/), on platform MediaExtractor/MediaCodec/MediaMuxer. This crate only
//! registers that class and exposes these commands:
//!
//!   transcode { input, output, format: "wav" | "m4a", kbps? } -> { path }
//!   open_file { path }                                        (absolute file path or content:// URI)
//!   ytdlp_status {} -> { ytdlp, ejs, jsRuntime, ffmpeg, ready, problems }   (bundled QuickJS/ffmpeg self-check)
//!   ytdlp_info { url, full? } -> { ok, info }                 (TikTok/Instagram/YouTube, yt-dlp via Chaquopy)
//!   ytdlp_download { url, formatId? | args?, outDir, fileName?, jobId, full? } -> { path, bytes }
//!                                                             (exactly one of formatId / args)
//!   ytdlp_cancel { jobId } -> {}
//!   ytdlp_mux { videoPath, audioPath, outDir, fileName } -> { path, bytes }
//!   editor_probe { uri } -> { width, height, duration, hasAudio, rotation }
//!   editor_export_video { uri, outPath, crop?: {x,y,w,h}, trimStart?, trimEnd?, audio } -> { path }
//!   editor_cancel {} -> {}            (progress: plugin event "keepsake-editor-progress" { fraction })
//!
//! JS: `invoke("plugin:keepsake-media|transcode", { input, output, format, kbps })`.
//! On desktop and iOS the command exists but always returns an error; the app
//! registers the plugin on mobile only.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.keepsake.media";

/// Output formats the native side implements this round.
const FORMATS: &[&str] = &["wav", "m4a"];

#[derive(Debug, Serialize)]
struct TranscodeArgs {
    input: String,
    output: String,
    format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscodeResponse {
    pub path: String,
}

#[cfg(target_os = "android")]
struct MediaHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Cheap checks before crossing into Kotlin. The Kotlin side re-checks that both
/// paths resolve inside the app cache or a download directory.
fn validate(input: &str, output: &str, format: &str) -> Result<(), String> {
    if !FORMATS.contains(&format) {
        return Err(format!(
            "Unsupported format \"{format}\" on Android. Supported formats: m4a, wav."
        ));
    }
    for (label, p) in [("input", input), ("output", output)] {
        let path = Path::new(p);
        // Android paths are POSIX; checked as text so the unit tests also pass on a Windows host.
        if !p.starts_with('/') {
            return Err(format!("The {label} path must be absolute: {p:?}"));
        }
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("The {label} path must not contain \"..\": {p:?}"));
        }
    }
    if input == output {
        return Err("Input and output must be different files.".into());
    }
    Ok(())
}

#[tauri::command]
async fn transcode<R: Runtime>(
    app: AppHandle<R>,
    input: String,
    output: String,
    format: String,
    kbps: Option<u32>,
) -> Result<TranscodeResponse, String> {
    let format = format.to_ascii_lowercase();
    validate(&input, &output, &format)?;
    run_native(
        app,
        TranscodeArgs {
            input,
            output,
            format,
            kbps,
        },
    )
    .await
}

#[cfg(target_os = "android")]
async fn run_native<R: Runtime>(
    app: AppHandle<R>,
    args: TranscodeArgs,
) -> Result<TranscodeResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<TranscodeResponse>("transcode", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_native<R: Runtime>(
    _app: AppHandle<R>,
    _args: TranscodeArgs,
) -> Result<TranscodeResponse, String> {
    Err("Native transcoding (keepsake-media) is only available on Android.".into())
}

#[derive(Debug, Serialize)]
struct OpenArgs {
    path: String,
}

#[derive(Debug, Deserialize)]
struct OpenResponse {}

/// Opens a downloaded file in another app (Android shares it through FileProvider).
/// Kotlin re-checks that the path is inside the app cache or a download folder.
#[tauri::command]
async fn open_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    if path.starts_with("content://") {
        validate_content_uri("open", &path)?;
        return run_open(app, OpenArgs { path }).await.map(|_| ());
    }
    if !path.starts_with('/') || Path::new(&path).components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("The file path must be absolute and must not contain \"..\": {path:?}"));
    }
    run_open(app, OpenArgs { path }).await.map(|_| ())
}

#[cfg(target_os = "android")]
async fn run_open<R: Runtime>(app: AppHandle<R>, args: OpenArgs) -> Result<OpenResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<OpenResponse>("openFile", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_open<R: Runtime>(_app: AppHandle<R>, _args: OpenArgs) -> Result<OpenResponse, String> {
    Err("Opening files through keepsake-media is only available on Android.".into())
}

/// Hosts yt-dlp serves on Android (exact host or any subdomain). Keep identical to
/// `ANDROID_YTDLP_HOSTS` in src/engine/android-ytdlp.ts.
pub const YTDLP_HOSTS: &[&str] = &[
    "tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "instagram.com",
    "instagr.am",
];

/// YouTube hosts yt-dlp may serve on Android (exact host match only, no other
/// subdomains). Kept separate from `YTDLP_HOSTS` so the TikTok/Instagram list stays
/// identical to `ANDROID_YTDLP_HOSTS`. The TS side gates use behind YOUTUBE_VIA_YTDLP.
pub const YTDLP_YOUTUBE_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpFormat {
    pub format_id: String,
    pub ext: String,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub height: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    pub fps: Option<f64>,
    #[serde(default)]
    pub tbr: Option<f64>,
    #[serde(default)]
    pub abr: Option<f64>,
    pub filesize: Option<u64>,
    pub protocol: String,
    pub format_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub extractor: String,
    pub webpage_url: String,
    pub formats: Vec<YtdlpFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpInfoResponse {
    pub ok: bool,
    pub info: YtdlpInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpDownloadResponse {
    pub path: String,
    pub bytes: u64,
}

/// Self-check of the bundled route (Python `keepsake_ytdlp.status()`). `None` serializes as `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpStatusResponse {
    #[serde(default, deserialize_with = "null_as_empty")]
    pub ytdlp: String,
    #[serde(default)]
    pub ejs: Option<String>,
    #[serde(default)]
    pub js_runtime: Option<String>,
    #[serde(default)]
    pub ffmpeg: Option<String>,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub problems: Vec<String>,
}

/// A missing or `null` string becomes "" (the TS type is `string`).
fn null_as_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Serialize)]
struct YtdlpStatusArgs {}

#[derive(Debug, Serialize)]
struct YtdlpInfoArgs {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    full: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpDownloadArgs {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    out_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    full: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpCancelArgs {
    job_id: String,
}

#[derive(Debug, Deserialize)]
struct YtdlpCancelResponse {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpMuxArgs {
    video_path: String,
    audio_path: String,
    out_dir: String,
    file_name: String,
}

fn validate_job_id(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.chars().count() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("ytdlp:unknown: Invalid job id: {s:?}"))
    }
}

/// Video inputs may be any container yt-dlp hands us for a video-only stream.
const MUX_VIDEO_EXTS: [&str; 4] = [".mp4", ".webm", ".mkv", ".part"];
/// Audio inputs may be any container yt-dlp hands us for an audio-only stream.
const MUX_AUDIO_EXTS: [&str; 7] = [".m4a", ".aac", ".mp4", ".webm", ".opus", ".ogg", ".part"];

/// Absolute, no "..", one of `exts` (checked as POSIX text).
fn validate_mux_input(label: &str, s: &str, exts: &[&str]) -> Result<(), String> {
    let ext_ok = exts.iter().any(|e| s.ends_with(e));
    if !s.starts_with('/')
        || Path::new(s).components().any(|c| matches!(c, Component::ParentDir))
        || !ext_ok
    {
        let allowed = exts
            .iter()
            .map(|e| format!("{e:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "ytdlp:unknown: The {label} path must be absolute, without \"..\", and end in one of {allowed}: {s:?}"
        ));
    }
    Ok(())
}

fn validate_mux(video: &str, audio: &str, out_dir: &str, file_name: &str) -> Result<(), String> {
    validate_mux_input("video", video, &MUX_VIDEO_EXTS)?;
    validate_mux_input("audio", audio, &MUX_AUDIO_EXTS)?;
    if video == audio {
        return Err("ytdlp:unknown: Video and audio must be different files.".into());
    }
    validate_out_dir(out_dir)?;
    validate_file_name(file_name)
}

/// https only. Host must be a `YTDLP_HOSTS` domain or a subdomain of one, or exactly
/// one of `YTDLP_YOUTUBE_HOSTS`.
fn validate_ytdlp_url(raw: &str) -> Result<(), String> {
    let err = || {
        format!("ytdlp:unsupported_url: Only https TikTok, Instagram and YouTube links are supported on Android: {raw}")
    };
    let url = tauri::Url::parse(raw).map_err(|_| err())?;
    if url.scheme() != "https" {
        return Err(err());
    }
    let host = url.host_str().ok_or_else(err)?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let ok = YTDLP_HOSTS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
        || YTDLP_YOUTUBE_HOSTS.contains(&host.as_str());
    if ok {
        Ok(())
    } else {
        Err(err())
    }
}

/// One concrete id `[A-Za-z0-9_.-]{1,64}`.
fn is_format_id_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
}

/// `^[A-Za-z0-9_.-]{1,64}(\+[A-Za-z0-9_.-]{1,64})?$`: one id, or two merged with one `+` (needs ffmpeg).
fn validate_format_id(s: &str) -> Result<(), String> {
    let parts: Vec<&str> = s.split('+').collect();
    let ok = (1..=2).contains(&parts.len()) && parts.iter().all(|p| is_format_id_part(p));
    if ok {
        Ok(())
    } else {
        Err(format!("ytdlp:unknown: Invalid format id: {s:?}"))
    }
}

/// Values allowed for `--merge-output-format`.
const SEL_MERGE_FORMATS: &[&str] = &["mp4/mkv", "mp4", "mkv", "webm"];
/// Values allowed for `--audio-format` (phase 3 adds mp3, opus, wav, flac).
const SEL_AUDIO_FORMATS: &[&str] = &["m4a"];
/// Values allowed for `--convert-thumbnails`.
const SEL_THUMB_FORMATS: &[&str] = &["jpg", "png"];
const SEL_MAX_ARGS: usize = 24;

/// `-f` value: `^[A-Za-z0-9_.+/\[\]<>=!*?^$:~-]{1,200}$` (no comma, space or quotes), not starting with `-`.
fn sel_format_ok(v: &str) -> bool {
    (1..=200).contains(&v.len())
        && !v.starts_with('-')
        && v.chars().all(|c| c.is_ascii_alphanumeric() || "_.+/[]<>=!*?^$:~-".contains(c))
}

/// `-S` value: `^[a-z0-9:,+_.-]{1,100}$`, not starting with `-`.
fn sel_sort_ok(v: &str) -> bool {
    (1..=100).contains(&v.len())
        && !v.starts_with('-')
        && v.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ":,+_.-".contains(c))
}

/// `--audio-quality` value: `^\d{2,3}K$`.
fn sel_audio_quality_ok(v: &str) -> bool {
    v.strip_suffix('K')
        .is_some_and(|d| (2..=3).contains(&d.len()) && d.chars().all(|c| c.is_ascii_digit()))
}

/// Selection argv for the self-contained route (1..=24 items). Only format selection and
/// post-processing flags; paths, output templates, runtimes, ffmpeg, cookies, extractor args
/// and the `--` separator are always rejected (the bridge sets those itself).
fn validate_selection_args(args: &[String]) -> Result<(), String> {
    let err = |m: String| Err(format!("ytdlp:unknown: Invalid selection argument: {m}"));
    if args.is_empty() || args.len() > SEL_MAX_ARGS {
        return err(format!("expected 1 to {SEL_MAX_ARGS} items, got {}", args.len()));
    }
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        match flag {
            "-x" | "--extract-audio" | "--embed-metadata" | "--embed-thumbnail" => {
                i += 1;
                continue;
            }
            "-f" | "--format" | "-S" | "--format-sort" | "--merge-output-format" | "--audio-format"
            | "--audio-quality" | "--convert-thumbnails" => {}
            _ => return err(format!("{flag:?} is not allowed")),
        }
        let Some(v) = args.get(i + 1).map(String::as_str) else {
            return err(format!("{flag} needs a value"));
        };
        let ok = match flag {
            "-f" | "--format" => sel_format_ok(v),
            "-S" | "--format-sort" => sel_sort_ok(v),
            "--merge-output-format" => SEL_MERGE_FORMATS.contains(&v),
            "--audio-format" => SEL_AUDIO_FORMATS.contains(&v),
            "--audio-quality" => sel_audio_quality_ok(v),
            _ => SEL_THUMB_FORMATS.contains(&v), // --convert-thumbnails
        };
        if !ok {
            return err(format!("{flag} {v:?}"));
        }
        i += 2;
    }
    Ok(())
}

/// Exactly one of `format_id` / `args` must be given; each is checked with its own rules.
fn validate_download_selection(format_id: Option<&str>, args: Option<&[String]>) -> Result<(), String> {
    match (format_id, args) {
        (Some(f), None) => validate_format_id(f),
        (None, Some(a)) => validate_selection_args(a),
        _ => Err("ytdlp:unknown: Exactly one of formatId and args is required.".into()),
    }
}

fn validate_out_dir(s: &str) -> Result<(), String> {
    // Checked as text (POSIX) so the tests also pass on a Windows host.
    if !s.starts_with('/') || Path::new(s).components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!(
            "ytdlp:unknown: The output folder must be absolute and must not contain \"..\": {s:?}"
        ));
    }
    Ok(())
}

fn validate_file_name(s: &str) -> Result<(), String> {
    let n = s.chars().count();
    if n == 0 || n > 200 || s.contains(['/', '\\', '\0']) || s.starts_with('.') {
        return Err(format!("ytdlp:unknown: Invalid file name: {s:?}"));
    }
    Ok(())
}

/// Self-check of the bundled yt-dlp route: versions of yt-dlp, the EJS solver, QuickJS and ffmpeg (Android only).
#[tauri::command]
async fn ytdlp_status<R: Runtime>(app: AppHandle<R>) -> Result<YtdlpStatusResponse, String> {
    run_ytdlp_status(app, YtdlpStatusArgs {}).await
}

/// Extracts media info for a TikTok, Instagram or YouTube link with yt-dlp (Android only).
/// `full` enables the bundled JS runtime / ffmpeg route; omitted means the legacy route.
#[tauri::command]
async fn ytdlp_info<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    full: Option<bool>,
) -> Result<YtdlpInfoResponse, String> {
    validate_ytdlp_url(&url)?;
    run_ytdlp_info(app, YtdlpInfoArgs { url, full }).await
}

/// Downloads into `out_dir` (Android only): either one concrete yt-dlp format id (or two
/// merged with one `+`), or a selection argv (`args`, desktop-style `-f`/`-S`/... flags).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ytdlp_download<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    format_id: Option<String>,
    args: Option<Vec<String>>,
    out_dir: String,
    file_name: Option<String>,
    job_id: String,
    full: Option<bool>,
) -> Result<YtdlpDownloadResponse, String> {
    validate_ytdlp_url(&url)?;
    validate_download_selection(format_id.as_deref(), args.as_deref())?;
    validate_job_id(&job_id)?;
    validate_out_dir(&out_dir)?;
    if let Some(n) = file_name.as_deref() {
        validate_file_name(n)?;
    }
    run_ytdlp_download(
        app,
        YtdlpDownloadArgs {
            url,
            format_id,
            args,
            out_dir,
            file_name,
            job_id,
            full,
        },
    )
    .await
}

/// Cancels a running yt-dlp download job (Android only).
#[tauri::command]
async fn ytdlp_cancel<R: Runtime>(app: AppHandle<R>, job_id: String) -> Result<(), String> {
    validate_job_id(&job_id)?;
    run_ytdlp_cancel(app, YtdlpCancelArgs { job_id }).await.map(|_| ())
}

/// Muxes a downloaded video and audio track into one file (Android only).
#[tauri::command]
async fn ytdlp_mux<R: Runtime>(
    app: AppHandle<R>,
    video_path: String,
    audio_path: String,
    out_dir: String,
    file_name: String,
) -> Result<YtdlpDownloadResponse, String> {
    validate_mux(&video_path, &audio_path, &out_dir, &file_name)?;
    run_ytdlp_mux(
        app,
        YtdlpMuxArgs {
            video_path,
            audio_path,
            out_dir,
            file_name,
        },
    )
    .await
}

#[cfg(target_os = "android")]
async fn run_ytdlp_cancel<R: Runtime>(
    app: AppHandle<R>,
    args: YtdlpCancelArgs,
) -> Result<YtdlpCancelResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<YtdlpCancelResponse>("ytdlpCancel", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_ytdlp_cancel<R: Runtime>(
    _app: AppHandle<R>,
    _args: YtdlpCancelArgs,
) -> Result<YtdlpCancelResponse, String> {
    Err("ytdlp:unknown: only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_ytdlp_mux<R: Runtime>(
    app: AppHandle<R>,
    args: YtdlpMuxArgs,
) -> Result<YtdlpDownloadResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<YtdlpDownloadResponse>("ytdlpMux", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_ytdlp_mux<R: Runtime>(
    _app: AppHandle<R>,
    _args: YtdlpMuxArgs,
) -> Result<YtdlpDownloadResponse, String> {
    Err("ytdlp:unknown: only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_ytdlp_status<R: Runtime>(
    app: AppHandle<R>,
    args: YtdlpStatusArgs,
) -> Result<YtdlpStatusResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<YtdlpStatusResponse>("ytdlpStatus", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_ytdlp_status<R: Runtime>(
    _app: AppHandle<R>,
    _args: YtdlpStatusArgs,
) -> Result<YtdlpStatusResponse, String> {
    Err("ytdlp:unknown: yt-dlp through keepsake-media is only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_ytdlp_info<R: Runtime>(
    app: AppHandle<R>,
    args: YtdlpInfoArgs,
) -> Result<YtdlpInfoResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<YtdlpInfoResponse>("ytdlpInfo", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_ytdlp_info<R: Runtime>(
    _app: AppHandle<R>,
    _args: YtdlpInfoArgs,
) -> Result<YtdlpInfoResponse, String> {
    Err("ytdlp:unknown: yt-dlp through keepsake-media is only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_ytdlp_download<R: Runtime>(
    app: AppHandle<R>,
    args: YtdlpDownloadArgs,
) -> Result<YtdlpDownloadResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<YtdlpDownloadResponse>("ytdlpDownload", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_ytdlp_download<R: Runtime>(
    _app: AppHandle<R>,
    _args: YtdlpDownloadArgs,
) -> Result<YtdlpDownloadResponse, String> {
    Err("ytdlp:unknown: yt-dlp through keepsake-media is only available on Android.".into())
}

// ---- Gallery and folder (SAF) saving -------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPublishResponse {
    pub uri: String,
    pub display_path: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderPickResponse {
    pub uri: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderStatusResponse {
    pub ok: bool,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSaveResponse {
    pub uri: String,
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GalleryPublishArgs {
    src: String,
    kind: String,
    file_name: String,
    mime: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderPickArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_uri: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderStatusArgs {
    tree_uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSaveArgs {
    src: String,
    tree_uri: String,
    file_name: String,
    mime: String,
}

/// `content://` only, at most 2048 chars, no NUL or whitespace. `prefix` is the error prefix.
fn validate_content_uri(prefix: &str, s: &str) -> Result<(), String> {
    let ok = s.starts_with("content://")
        && s.len() > "content://".len()
        && s.chars().count() <= 2048
        && !s.chars().any(|c| c == '\0' || c.is_whitespace());
    if ok {
        Ok(())
    } else {
        Err(format!("{prefix}:bad_uri: Invalid content URI: {s:?}"))
    }
}

/// A SAF tree URI: content:// with a `/tree/` segment.
fn validate_tree_uri(prefix: &str, s: &str) -> Result<(), String> {
    validate_content_uri(prefix, s)?;
    if !s.contains("/tree/") {
        return Err(format!("{prefix}:bad_uri: Not a folder (tree) URI: {s:?}"));
    }
    Ok(())
}

fn validate_media_kind(s: &str) -> Result<(), String> {
    if matches!(s, "video" | "audio" | "image") {
        Ok(())
    } else {
        Err(format!("gallery:unknown: Invalid media kind: {s:?}"))
    }
}

/// Same rules as `validate_file_name`, with a `prefix:` error instead of `ytdlp:`.
fn validate_save_file_name(prefix: &str, s: &str) -> Result<(), String> {
    validate_file_name(s).map_err(|_| format!("{prefix}:unknown: Invalid file name: {s:?}"))
}

fn validate_save_src(prefix: &str, s: &str) -> Result<(), String> {
    if !s.starts_with('/') || Path::new(s).components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!(
            "{prefix}:unknown: The source path must be absolute and must not contain \"..\": {s:?}"
        ));
    }
    Ok(())
}

fn validate_mime(prefix: &str, s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 100
        && s.contains('/')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "/+-._".contains(c));
    if ok {
        Ok(())
    } else {
        Err(format!("{prefix}:unknown: Invalid MIME type: {s:?}"))
    }
}

fn validate_gallery_publish(src: &str, kind: &str, file_name: &str, mime: &str) -> Result<(), String> {
    validate_save_src("gallery", src)?;
    validate_media_kind(kind)?;
    validate_save_file_name("gallery", file_name)?;
    validate_mime("gallery", mime)
}

fn validate_folder_save(src: &str, tree_uri: &str, file_name: &str, mime: &str) -> Result<(), String> {
    validate_save_src("folder", src)?;
    validate_tree_uri("folder", tree_uri)?;
    validate_save_file_name("folder", file_name)?;
    validate_mime("folder", mime)
}

/// Publishes a finished file into the public Gallery (MediaStore) folder (Android only).
#[tauri::command]
async fn gallery_publish<R: Runtime>(
    app: AppHandle<R>,
    src: String,
    kind: String,
    file_name: String,
    mime: String,
) -> Result<GalleryPublishResponse, String> {
    validate_gallery_publish(&src, &kind, &file_name, &mime)?;
    run_gallery_publish(
        app,
        GalleryPublishArgs {
            src,
            kind,
            file_name,
            mime,
        },
    )
    .await
}

/// Lets the user pick a save folder (SAF tree) (Android only).
#[tauri::command]
async fn folder_pick<R: Runtime>(
    app: AppHandle<R>,
    initial_uri: Option<String>,
) -> Result<FolderPickResponse, String> {
    if let Some(u) = initial_uri.as_deref() {
        validate_content_uri("folder", u)?;
    }
    run_folder_pick(app, FolderPickArgs { initial_uri }).await
}

/// Checks that the persisted grant for a picked folder still exists (Android only).
#[tauri::command]
async fn folder_status<R: Runtime>(
    app: AppHandle<R>,
    tree_uri: String,
) -> Result<FolderStatusResponse, String> {
    validate_tree_uri("folder", &tree_uri)?;
    run_folder_status(app, FolderStatusArgs { tree_uri }).await
}

/// Copies a finished file into the picked folder and removes the source (Android only).
#[tauri::command]
async fn folder_save<R: Runtime>(
    app: AppHandle<R>,
    src: String,
    tree_uri: String,
    file_name: String,
    mime: String,
) -> Result<FolderSaveResponse, String> {
    validate_folder_save(&src, &tree_uri, &file_name, &mime)?;
    run_folder_save(
        app,
        FolderSaveArgs {
            src,
            tree_uri,
            file_name,
            mime,
        },
    )
    .await
}

#[cfg(target_os = "android")]
async fn run_gallery_publish<R: Runtime>(
    app: AppHandle<R>,
    args: GalleryPublishArgs,
) -> Result<GalleryPublishResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<GalleryPublishResponse>("galleryPublish", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_gallery_publish<R: Runtime>(
    _app: AppHandle<R>,
    _args: GalleryPublishArgs,
) -> Result<GalleryPublishResponse, String> {
    Err("gallery:unknown: only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_folder_pick<R: Runtime>(
    app: AppHandle<R>,
    args: FolderPickArgs,
) -> Result<FolderPickResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<FolderPickResponse>("folderPick", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_folder_pick<R: Runtime>(
    _app: AppHandle<R>,
    _args: FolderPickArgs,
) -> Result<FolderPickResponse, String> {
    Err("folder:unknown: only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_folder_status<R: Runtime>(
    app: AppHandle<R>,
    args: FolderStatusArgs,
) -> Result<FolderStatusResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<FolderStatusResponse>("folderStatus", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_folder_status<R: Runtime>(
    _app: AppHandle<R>,
    _args: FolderStatusArgs,
) -> Result<FolderStatusResponse, String> {
    Err("folder:unknown: only available on Android.".into())
}

#[cfg(target_os = "android")]
async fn run_folder_save<R: Runtime>(
    app: AppHandle<R>,
    args: FolderSaveArgs,
) -> Result<FolderSaveResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<FolderSaveResponse>("folderSave", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_folder_save<R: Runtime>(
    _app: AppHandle<R>,
    _args: FolderSaveArgs,
) -> Result<FolderSaveResponse, String> {
    Err("folder:unknown: only available on Android.".into())
}

// ---- Editor (Media3 Transformer crop / trim / mute) -----------------------------

/// Display-oriented video facts. `duration` is in seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorProbeResponse {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub has_audio: bool,
    pub rotation: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorExportResponse {
    pub path: String,
}

/// Crop rectangle in display-oriented source pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct EditorCrop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Serialize)]
struct EditorProbeArgs {
    uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorExportArgs {
    uri: String,
    out_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    crop: Option<EditorCrop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trim_start: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trim_end: Option<f64>,
    audio: bool,
}

#[derive(Debug, Serialize)]
struct EditorCancelArgs {}

#[derive(Debug, Deserialize)]
struct EditorCancelResponse {}

/// Source video: a content:// URI or an absolute POSIX path without "..".
fn validate_editor_uri(s: &str) -> Result<(), String> {
    if s.starts_with("content://") {
        return validate_content_uri("editor", s)
            .map_err(|_| format!("editor:unsupported: Invalid video address: {s:?}"));
    }
    if !s.starts_with('/')
        || s.contains('\0')
        || Path::new(s).components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "editor:unsupported: The video must be a content:// URI or an absolute path without \"..\": {s:?}"
        ));
    }
    Ok(())
}

/// Export target: absolute, no "..", ends in ".mp4". Kotlin re-checks it is inside the app cache
/// or a download folder (canonical path).
fn validate_editor_out_path(s: &str) -> Result<(), String> {
    if !s.starts_with('/')
        || s.contains('\0')
        || Path::new(s).components().any(|c| matches!(c, Component::ParentDir))
        || !s.to_ascii_lowercase().ends_with(".mp4")
        || s.ends_with("/.mp4")
    {
        return Err(format!(
            "editor:unsupported: The output must be an absolute .mp4 path without \"..\": {s:?}"
        ));
    }
    Ok(())
}

/// Finite, non-negative origin and a positive size. Bounds against the video are checked in Kotlin.
fn validate_editor_crop(c: &EditorCrop) -> Result<(), String> {
    let finite = [c.x, c.y, c.w, c.h].iter().all(|v| v.is_finite());
    if !finite || c.x < 0.0 || c.y < 0.0 || c.w < 2.0 || c.h < 2.0 {
        return Err(format!("editor:unsupported: Invalid crop rectangle: {c:?}"));
    }
    Ok(())
}

/// Seconds; finite and non-negative, and end after start when both are set.
fn validate_editor_trim(start: Option<f64>, end: Option<f64>) -> Result<(), String> {
    for v in [start, end].into_iter().flatten() {
        if !v.is_finite() || v < 0.0 {
            return Err(format!("editor:unsupported: Invalid trim time: {v}"));
        }
    }
    if let (Some(s), Some(e)) = (start, end) {
        if e <= s {
            return Err(format!(
                "editor:unsupported: The trim end ({e}) must be after the trim start ({s})."
            ));
        }
    }
    Ok(())
}

fn validate_editor_export(
    uri: &str,
    out_path: &str,
    crop: Option<&EditorCrop>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
) -> Result<(), String> {
    validate_editor_uri(uri)?;
    validate_editor_out_path(out_path)?;
    if let Some(c) = crop {
        validate_editor_crop(c)?;
    }
    validate_editor_trim(trim_start, trim_end)
}

/// Reads display size, duration (s), audio presence and rotation of a video (Android only).
#[tauri::command]
async fn editor_probe<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<EditorProbeResponse, String> {
    validate_editor_uri(&uri)?;
    run_editor_probe(app, EditorProbeArgs { uri }).await
}

/// Crops / trims / mutes a video into an H.264+AAC MP4 inside the app cache (Android only).
/// Progress: plugin event "keepsake-editor-progress" `{ fraction }`.
#[tauri::command]
async fn editor_export_video<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
    out_path: String,
    crop: Option<EditorCrop>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    audio: bool,
) -> Result<EditorExportResponse, String> {
    validate_editor_export(&uri, &out_path, crop.as_ref(), trim_start, trim_end)?;
    run_editor_export(
        app,
        EditorExportArgs {
            uri,
            out_path,
            crop,
            trim_start,
            trim_end,
            audio,
        },
    )
    .await
}

/// Cancels the running editor export; it then rejects with `editor:cancelled:` (Android only).
#[tauri::command]
async fn editor_cancel<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    run_editor_cancel(app, EditorCancelArgs {}).await.map(|_| ())
}

#[cfg(target_os = "android")]
async fn run_editor_probe<R: Runtime>(
    app: AppHandle<R>,
    args: EditorProbeArgs,
) -> Result<EditorProbeResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<EditorProbeResponse>("editorProbe", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_editor_probe<R: Runtime>(
    _app: AppHandle<R>,
    _args: EditorProbeArgs,
) -> Result<EditorProbeResponse, String> {
    Err("editor:unsupported: Android only.".into())
}

#[cfg(target_os = "android")]
async fn run_editor_export<R: Runtime>(
    app: AppHandle<R>,
    args: EditorExportArgs,
) -> Result<EditorExportResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<EditorExportResponse>("editorExportVideo", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_editor_export<R: Runtime>(
    _app: AppHandle<R>,
    _args: EditorExportArgs,
) -> Result<EditorExportResponse, String> {
    Err("editor:unsupported: Android only.".into())
}

#[cfg(target_os = "android")]
async fn run_editor_cancel<R: Runtime>(
    app: AppHandle<R>,
    args: EditorCancelArgs,
) -> Result<EditorCancelResponse, String> {
    let handle = app.state::<MediaHandle<R>>().0.clone();
    handle
        .run_mobile_plugin_async::<EditorCancelResponse>("editorCancel", args)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
async fn run_editor_cancel<R: Runtime>(
    _app: AppHandle<R>,
    _args: EditorCancelArgs,
) -> Result<EditorCancelResponse, String> {
    Err("editor:unsupported: Android only.".into())
}

/// Initializes the plugin. Register it on mobile only:
/// `#[cfg(mobile)] builder.plugin(tauri_plugin_keepsake_media::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keepsake-media")
        .invoke_handler(tauri::generate_handler![
            transcode,
            open_file,
            ytdlp_status,
            ytdlp_info,
            ytdlp_download,
            ytdlp_cancel,
            ytdlp_mux,
            gallery_publish,
            folder_pick,
            folder_status,
            folder_save,
            editor_probe,
            editor_export_video,
            editor_cancel
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "KeepsakeMediaPlugin")?;
                app.manage(MediaHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{
        validate, validate_file_name, validate_format_id, validate_job_id, validate_mux,
        validate_out_dir, validate_ytdlp_url, YtdlpFormat,
    };
    use super::{
        validate_download_selection, validate_selection_args, YtdlpDownloadArgs, YtdlpInfoArgs,
        YtdlpStatusArgs, YtdlpStatusResponse,
    };
    use super::{
        validate_content_uri, validate_folder_save, validate_gallery_publish, validate_media_kind,
        validate_tree_uri,
    };

    use super::{
        validate_editor_crop, validate_editor_export, validate_editor_out_path, validate_editor_trim,
        validate_editor_uri, EditorCrop, EditorExportArgs, EditorProbeResponse,
    };

    const TREE: &str = "content://com.android.externalstorage.documents/tree/primary%3AMovies";
    const OUT: &str = "/data/user/0/app.keepsake/cache/gallery-editor-1/out.mp4";

    fn crop(x: f64, y: f64, w: f64, h: f64) -> EditorCrop {
        EditorCrop { x, y, w, h }
    }

    #[test]
    fn editor_uri_rules() {
        assert!(validate_editor_uri("content://media/external/video/media/12").is_ok());
        assert!(validate_editor_uri("/storage/emulated/0/Movies/a.mp4").is_ok());
        for bad in ["", "a.mp4", "/a/../b.mp4", "file:///a.mp4", "content://", "content://a b", "/a\0b"] {
            let e = validate_editor_uri(bad).unwrap_err();
            assert!(e.starts_with("editor:unsupported:"), "{bad:?} -> {e}");
        }
    }

    #[test]
    fn editor_out_path_rules() {
        assert!(validate_editor_out_path(OUT).is_ok());
        assert!(validate_editor_out_path("/c/x.MP4").is_ok());
        for bad in ["out.mp4", "/c/../x.mp4", "/c/x.mov", "/c/x.mp4.part", "/c/.mp4", "/c/x\0.mp4", ""] {
            let e = validate_editor_out_path(bad).unwrap_err();
            assert!(e.starts_with("editor:unsupported:"), "{bad:?} -> {e}");
        }
    }

    #[test]
    fn editor_crop_rules() {
        assert!(validate_editor_crop(&crop(0.0, 0.0, 1080.0, 1920.0)).is_ok());
        assert!(validate_editor_crop(&crop(10.5, 20.25, 2.0, 2.0)).is_ok());
        assert!(validate_editor_crop(&crop(-1.0, 0.0, 10.0, 10.0)).is_err());
        assert!(validate_editor_crop(&crop(0.0, 0.0, 0.0, 10.0)).is_err());
        assert!(validate_editor_crop(&crop(0.0, 0.0, 10.0, 1.0)).is_err());
        assert!(validate_editor_crop(&crop(f64::NAN, 0.0, 10.0, 10.0)).is_err());
        assert!(validate_editor_crop(&crop(0.0, 0.0, f64::INFINITY, 10.0)).is_err());
    }

    #[test]
    fn editor_trim_rules() {
        assert!(validate_editor_trim(None, None).is_ok());
        assert!(validate_editor_trim(Some(0.0), None).is_ok());
        assert!(validate_editor_trim(None, Some(3.5)).is_ok());
        assert!(validate_editor_trim(Some(1.0), Some(2.0)).is_ok());
        assert!(validate_editor_trim(Some(2.0), Some(2.0)).is_err());
        assert!(validate_editor_trim(Some(3.0), Some(2.0)).is_err());
        assert!(validate_editor_trim(Some(-0.1), None).is_err());
        assert!(validate_editor_trim(None, Some(f64::NAN)).is_err());
        let e = validate_editor_trim(Some(f64::INFINITY), None).unwrap_err();
        assert!(e.starts_with("editor:unsupported:"));
    }

    #[test]
    fn editor_export_rules() {
        let c = crop(0.0, 0.0, 100.0, 100.0);
        assert!(validate_editor_export("content://media/x/1", OUT, Some(&c), Some(1.0), Some(2.0)).is_ok());
        assert!(validate_editor_export("content://media/x/1", OUT, None, None, None).is_ok());
        assert!(validate_editor_export("x", OUT, None, None, None).is_err());
        assert!(validate_editor_export("content://media/x/1", "/c/x.webm", None, None, None).is_err());
        assert!(validate_editor_export("content://media/x/1", OUT, Some(&crop(0.0, 0.0, 0.0, 0.0)), None, None).is_err());
        assert!(validate_editor_export("content://media/x/1", OUT, None, Some(5.0), Some(1.0)).is_err());
    }

    #[test]
    fn editor_export_args_wire_format() {
        let full = serde_json::to_value(EditorExportArgs {
            uri: "content://m/1".into(),
            out_path: OUT.into(),
            crop: Some(crop(1.0, 2.0, 30.0, 40.0)),
            trim_start: Some(0.5),
            trim_end: Some(4.0),
            audio: false,
        })
        .unwrap();
        assert_eq!(
            full,
            serde_json::json!({
                "uri": "content://m/1", "outPath": OUT,
                "crop": {"x": 1.0, "y": 2.0, "w": 30.0, "h": 40.0},
                "trimStart": 0.5, "trimEnd": 4.0, "audio": false
            })
        );
        let bare = serde_json::to_value(EditorExportArgs {
            uri: "content://m/1".into(),
            out_path: OUT.into(),
            crop: None,
            trim_start: None,
            trim_end: None,
            audio: true,
        })
        .unwrap();
        assert_eq!(bare, serde_json::json!({"uri": "content://m/1", "outPath": OUT, "audio": true}));
    }

    #[test]
    fn editor_probe_response_parses_kotlin_shape() {
        let p: EditorProbeResponse = serde_json::from_str(
            r#"{"width":1080,"height":1920,"duration":12.345,"hasAudio":true,"rotation":90}"#,
        )
        .unwrap();
        assert_eq!((p.width, p.height, p.rotation), (1080, 1920, 90));
        assert!(p.has_audio && (p.duration - 12.345).abs() < 1e-9);
    }

    #[test]
    fn ytdlp_format_keeps_bitrate_and_width() {
        // Mirrors keepsake_ytdlp._reduce_format output: ints for height/width/filesize, floats for tbr/abr/fps.
        let f: YtdlpFormat = serde_json::from_str(
            r#"{"format_id":"137","ext":"mp4","vcodec":"avc1","acodec":null,"height":1080,"width":1920,
                "fps":30.0,"tbr":4321.5,"abr":128.0,"filesize":null,"protocol":"https","format_note":null}"#,
        )
        .unwrap();
        assert_eq!(f.width, Some(1920));
        assert_eq!(f.tbr, Some(4321.5));
        assert_eq!(f.abr, Some(128.0));
        assert_eq!(f.height, Some(1080));
        let back: YtdlpFormat = serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(back.width, Some(1920));
        assert_eq!(back.tbr, Some(4321.5));
        assert_eq!(back.abr, Some(128.0));
    }

    #[test]
    fn ytdlp_format_missing_and_null_optionals_parse() {
        let base = r#""format_id":"18","ext":"mp4","protocol":"https""#;
        let f: YtdlpFormat = serde_json::from_str(&format!("{{{base}}}")).unwrap();
        assert!(f.tbr.is_none() && f.abr.is_none() && f.width.is_none());
        let f: YtdlpFormat =
            serde_json::from_str(&format!(r#"{{{base},"tbr":null,"abr":null,"width":null}}"#)).unwrap();
        assert!(f.tbr.is_none() && f.abr.is_none() && f.width.is_none());
    }

    #[test]
    fn content_uri_rules() {
        assert!(validate_content_uri("folder", TREE).is_ok());
        assert!(validate_content_uri("open", "content://media/external/video/media/12").is_ok());
        assert!(validate_content_uri("folder", "file:///sdcard/x").is_err());
        assert!(validate_content_uri("folder", "/sdcard/x").is_err());
        assert!(validate_content_uri("folder", "content://").is_err());
        assert!(validate_content_uri("folder", "content://a/tree/b c").is_err());
        assert!(validate_content_uri("folder", "content://a/tree/b\0").is_err());
        assert!(validate_content_uri("folder", "content://a/tree/b\n").is_err());
        let long = format!("content://a/tree/{}", "x".repeat(2048));
        assert!(validate_content_uri("folder", &long).is_err());
        let max = format!("content://a/tree/{}", "x".repeat(2048 - "content://a/tree/".len()));
        assert!(validate_content_uri("folder", &max).is_ok());
        let e = validate_content_uri("folder", "http://x").unwrap_err();
        assert!(e.starts_with("folder:"));
    }

    #[test]
    fn tree_uri_rules() {
        assert!(validate_tree_uri("folder", TREE).is_ok());
        assert!(validate_tree_uri("folder", "content://media/external/video/media/12").is_err());
    }

    #[test]
    fn media_kind_rules() {
        for k in ["video", "audio", "image"] {
            assert!(validate_media_kind(k).is_ok());
        }
        assert!(validate_media_kind("Video").is_err());
        assert!(validate_media_kind("").is_err());
        assert!(validate_media_kind("document").is_err());
    }

    #[test]
    fn gallery_publish_rules() {
        assert!(validate_gallery_publish("/c/g-1/a.mp4", "video", "a.mp4", "video/mp4").is_ok());
        assert!(validate_gallery_publish("c/a.mp4", "video", "a.mp4", "video/mp4").is_err());
        assert!(validate_gallery_publish("/c/../a.mp4", "video", "a.mp4", "video/mp4").is_err());
        assert!(validate_gallery_publish("/c/a.mp4", "file", "a.mp4", "video/mp4").is_err());
        assert!(validate_gallery_publish("/c/a.mp4", "video", "a/b.mp4", "video/mp4").is_err());
        assert!(validate_gallery_publish("/c/a.mp4", "video", ".a", "video/mp4").is_err());
        assert!(validate_gallery_publish("/c/a.mp4", "video", "a.mp4", "mp4").is_err());
        let e = validate_gallery_publish("/c/a.mp4", "video", "", "video/mp4").unwrap_err();
        assert!(e.starts_with("gallery:"));
    }

    #[test]
    fn folder_save_rules() {
        assert!(validate_folder_save("/c/a.m4a", TREE, "a.m4a", "audio/mp4").is_ok());
        assert!(validate_folder_save("/c/a.m4a", "/sdcard", "a.m4a", "audio/mp4").is_err());
        assert!(validate_folder_save("/c/a.m4a", TREE, "a\\b", "audio/mp4").is_err());
        assert!(validate_folder_save("a.m4a", TREE, "a.m4a", "audio/mp4").is_err());
        let e = validate_folder_save("/c/a.m4a", TREE, "", "audio/mp4").unwrap_err();
        assert!(e.starts_with("folder:"));
    }

    #[test]
    fn ytdlp_job_id_rules() {
        assert!(validate_job_id("job_1-A").is_ok());
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("a.b").is_err());
        assert!(validate_job_id("a b").is_err());
        assert!(validate_job_id(&"a".repeat(64)).is_ok());
        assert!(validate_job_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn ytdlp_mux_rules() {
        let ok = |v: &str, a: &str, d: &str, n: &str| validate_mux(v, a, d, n).is_ok();
        assert!(ok("/c/v.mp4", "/c/a.m4a", "/d", "out.mp4"));
        assert!(ok("/c/v.webm", "/c/a.part", "/d", "out"));
        // Every container yt-dlp can produce for a single stream is accepted.
        assert!(ok("/c/v.mkv", "/c/a.m4a", "/d", "out.mp4"));
        assert!(ok("/c/v.part", "/c/a.opus", "/d", "out.webm"));
        assert!(ok("/c/v.webm", "/c/a.ogg", "/d", "out"));
        assert!(ok("/c/v.mp4", "/c/a.aac", "/d", "out.mp4"));
        assert!(ok("/c/v.mp4", "/c/a.mp4", "/d", "out"));
        assert!(ok("/c/v.mp4", "/c/a.webm", "/d", "out"));
        assert!(!ok("c/v.mp4", "/c/a.m4a", "/d", "out.mp4"));
        assert!(!ok("/c/../v.mp4", "/c/a.m4a", "/d", "out.mp4"));
        assert!(!ok("/c/v.mp4", "/c/v.mp4", "/d", "out.mp4"));
        assert!(!ok("/c/v.mov", "/c/a.m4a", "/d", "out.mp4"));
        assert!(!ok("/c/v.mp4", "/c/a.mp3", "/d", "out.mp4"));
        assert!(!ok("/c/v.mp4", "/c/a.m4a", "d", "out.mp4"));
        assert!(!ok("/c/v.mp4", "/c/a.m4a", "/d", "a/b.mp4"));
        assert!(!ok("/c/v.mp4", "/c/a.m4a", "/d", ""));
    }

    #[test]
    fn ytdlp_url_accepts_allowed_hosts() {
        for u in [
            "https://www.tiktok.com/@a/video/1",
            "https://vm.tiktok.com/ZM123/",
            "https://www.instagram.com/reel/abc/",
            "https://instagr.am/p/x",
        ] {
            assert!(validate_ytdlp_url(u).is_ok(), "{u}");
        }
    }

    #[test]
    fn ytdlp_url_rejects_others() {
        for u in [
            "http://www.tiktok.com/@a/video/1",
            "https://tiktok.com.evil.com/x",
            "https://nottiktok.com/x",
            "https://instagram.com@evil.com/x",
            // youtube.com is now accepted (YTDLP_YOUTUBE_HOSTS); see ytdlp_url_youtube_hosts.
            "not a url",
            "",
        ] {
            let e = validate_ytdlp_url(u).unwrap_err();
            assert!(e.starts_with("ytdlp:unsupported_url:"), "{u}");
        }
    }

    #[test]
    fn ytdlp_url_youtube_hosts() {
        for u in [
            "https://youtube.com/watch?v=x",
            "https://www.youtube.com/watch?v=x",
            "https://m.youtube.com/watch?v=x",
            "https://music.youtube.com/watch?v=x",
            "https://youtu.be/x",
            "https://www.youtube.com/shorts/x",
            "https://www.youtube.com/live/x",
            "https://www.youtube.com/embed/x",
            "https://WWW.YouTube.com./shorts/x",
        ] {
            assert!(validate_ytdlp_url(u).is_ok(), "{u}");
        }
        for u in [
            "http://www.youtube.com/watch?v=x",
            "https://gaming.youtube.com/watch?v=x",
            "https://music.youtube.com.evil.com/x",
            "https://youtube.com.evil.com/x",
            "https://notyoutube.com/x",
            "https://youtube.com@evil.com/x",
            "https://x.youtu.be/x",
        ] {
            let e = validate_ytdlp_url(u).unwrap_err();
            assert!(e.starts_with("ytdlp:unsupported_url:"), "{u}");
        }
    }

    #[test]
    fn ytdlp_format_id_rules() {
        assert!(validate_format_id("bytevc1_1080p_123-0").is_ok());
        // One "+" merge of two concrete ids is allowed (ffmpeg merges them).
        assert!(validate_format_id("137+140").is_ok());
        assert!(validate_format_id("dash-1+2").is_ok());
        assert!(validate_format_id("a+b+c").is_err());
        assert!(validate_format_id("a+").is_err());
        assert!(validate_format_id("+a").is_err());
        assert!(validate_format_id("a,b").is_err());
        assert!(validate_format_id("").is_err());
        assert!(validate_format_id(&"a".repeat(64)).is_ok());
        assert!(validate_format_id(&"a".repeat(65)).is_err());
        assert!(validate_format_id(&format!("{}+{}", "a".repeat(64), "b".repeat(64))).is_ok());
        assert!(validate_format_id(&format!("{}+{}", "a".repeat(64), "b".repeat(65))).is_err());
        let e = validate_format_id("a b").unwrap_err();
        assert!(e.starts_with("ytdlp:unknown:"));
    }

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn selection_accepts_every_desktop_selector() {
        // Every -f / -S form src/engine/ytdlp.ts buildDownloadArgs can emit.
        let mut formats: Vec<String> = vec![
            "bestvideo+bestaudio/best/best".into(),
            "137+bestaudio[ext=m4a]/137+bestaudio".into(),
            "hls-1080p+bestaudio[ext=m4a]/hls-1080p+bestaudio".into(),
            "dash-video=1234+bestaudio[ext=m4a]/dash-video=1234+bestaudio".into(),
            "http-720p".into(),
            "18".into(),
            "bestaudio[ext=m4a]".into(),
            "bestaudio[ext=m4a]/bestaudio/best".into(),
            "bestaudio[acodec=opus]/bestaudio/best".into(),
            "bestaudio/best".into(),
            // Other yt-dlp filter operators the allow-list keeps open.
            "bv*[vcodec^=avc1][height<=?1080]+ba[ext!=webm]/b".into(),
            "best[format_id~=x]".into(),
            "bv[ext$=mp4]+ba[acodec*=mp4a]/b".into(),
        ];
        for h in [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320] {
            formats.push(format!("bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"));
        }
        for f in &formats {
            for flag in ["-f", "--format"] {
                let a = sv(&[flag, f.as_str()]);
                assert!(validate_selection_args(&a).is_ok(), "{flag} {f}");
            }
        }
        // Full desktop-shaped selections (video, preferH264 video, audio variants).
        for a in [
            sv(&["-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best", "-S",
                "res,fps,vcodec:h264,acodec:aac", "--merge-output-format", "mp4/mkv"]),
            sv(&["-f", "bestvideo+bestaudio/best/best", "--merge-output-format", "mp4/mkv",
                "--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata"]),
            sv(&["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a",
                "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"]),
            sv(&["-f", "bestaudio[ext=m4a]", "--embed-metadata"]),
            sv(&["--extract-audio", "--audio-format", "m4a"]),
            sv(&["--format-sort", "res,fps", "--audio-quality", "192K", "--audio-quality", "320K"]),
            sv(&["--merge-output-format", "mp4"]),
            sv(&["--merge-output-format", "mkv"]),
            sv(&["--merge-output-format", "webm"]),
            sv(&["--convert-thumbnails", "png"]),
        ] {
            assert!(validate_selection_args(&a).is_ok(), "{a:?}");
        }
    }

    #[test]
    fn selection_dead_and_dangerous_flags_rejected() {
        for f in [
            "-o",
            "--output",
            "-P",
            "--paths",
            "--exec",
            "--exec-before-download",
            "--ffmpeg-location",
            "--js-runtimes",
            "--no-js-runtimes",
            "--remote-components",
            "--extractor-args",
            "--postprocessor-args",
            "--ppa",
            "--plugin-dirs",
            "--config-location",
            "--config-locations",
            "--cookies",
            "--cookies-from-browser",
            "--load-info-json",
            "--batch-file",
            "-a",
            "--use-postprocessor",
            "--remux-video",
            "--recode-video",
            "--downloader",
            "--print",
            "--",
            "-f=best",
            "--format=best",
            "https://www.youtube.com/watch?v=x",
            "",
        ] {
            let e = validate_selection_args(&sv(&[f, "x"])).unwrap_err();
            assert!(e.starts_with("ytdlp:unknown:"), "{f} -> {e}");
        }
        // A disallowed flag cannot hide as the value of an allowed one and then reappear.
        assert!(validate_selection_args(&sv(&["-f", "best", "--exec", "calc"])).is_err());
        assert!(validate_selection_args(&sv(&["-f", "best", "--", "https://x"])).is_err());
        // Nor be swallowed as a value: values never start with "-".
        assert!(validate_selection_args(&sv(&["-f", "-o"])).is_err());
        assert!(validate_selection_args(&sv(&["-S", "-o"])).is_err());
        // Missing value.
        assert!(validate_selection_args(&sv(&["-f"])).is_err());
        assert!(validate_selection_args(&sv(&["-x", "--audio-format"])).is_err());
    }

    #[test]
    fn selection_value_rules() {
        fn bad(a: &[&str]) -> bool {
            validate_selection_args(&sv(a)).is_err()
        }
        // -f: no comma, space, quotes, parens, pipes, semicolons; 1..=200 chars.
        for f in ["best,worst", "best video", "best'", "best\"", "(best)", "best|x", "best;x", "", "bestvideo\n"] {
            assert!(bad(&["-f", f]), "-f {f:?}");
        }
        assert!(!bad(&["-f", "b".repeat(200).as_str()]));
        assert!(bad(&["-f", "b".repeat(201).as_str()]));
        // -S: lowercase field list only, 1..=100 chars.
        assert!(bad(&["-S", "RES"]));
        assert!(bad(&["-S", "res 1080"]));
        assert!(bad(&["-S", "res[height]"]));
        assert!(!bad(&["-S", "r".repeat(100).as_str()]));
        assert!(bad(&["-S", "r".repeat(101).as_str()]));
        // Fixed value sets.
        assert!(bad(&["--merge-output-format", "avi"]));
        assert!(bad(&["--merge-output-format", "mp4/webm"]));
        assert!(bad(&["--audio-format", "mp3"])); // phase 3
        assert!(bad(&["--audio-format", "best"]));
        assert!(bad(&["--convert-thumbnails", "webp"]));
        // --audio-quality: two or three digits then K.
        for q in ["9K", "1000K", "192", "192k", "K", "abcK", "0"] {
            assert!(bad(&["--audio-quality", q]), "{q}");
        }
        assert!(!bad(&["--audio-quality", "64K"]));
        // Flags without value take no value.
        assert!(bad(&["-x", "m4a"]));
        // Size: 1..=24 items.
        assert!(validate_selection_args(&[]).is_err());
        let max: Vec<String> = std::iter::repeat("-x".to_string()).take(24).collect();
        assert!(validate_selection_args(&max).is_ok());
        let over: Vec<String> = std::iter::repeat("-x".to_string()).take(25).collect();
        assert!(validate_selection_args(&over).is_err());
    }

    #[test]
    fn download_needs_exactly_one_selection() {
        let a = sv(&["-f", "best"]);
        assert!(validate_download_selection(Some("18"), None).is_ok());
        assert!(validate_download_selection(Some("137+140"), None).is_ok());
        assert!(validate_download_selection(None, Some(a.as_slice())).is_ok());
        assert!(validate_download_selection(None, None).is_err());
        assert!(validate_download_selection(Some("18"), Some(a.as_slice())).is_err());
        assert!(validate_download_selection(Some("a+b+c"), None).is_err());
        let empty: Vec<String> = Vec::new();
        assert!(validate_download_selection(None, Some(empty.as_slice())).is_err());
        let e = validate_download_selection(None, None).unwrap_err();
        assert!(e.starts_with("ytdlp:unknown:"));
    }

    #[test]
    fn ytdlp_download_args_wire_format() {
        // Legacy shape is unchanged: no args / full keys at all.
        let legacy = serde_json::to_value(YtdlpDownloadArgs {
            url: "https://vm.tiktok.com/x".into(),
            format_id: Some("h264_720p".into()),
            args: None,
            out_dir: "/c/d".into(),
            file_name: None,
            job_id: "j1".into(),
            full: None,
        })
        .unwrap();
        assert_eq!(
            legacy,
            serde_json::json!({"url": "https://vm.tiktok.com/x", "formatId": "h264_720p", "outDir": "/c/d", "jobId": "j1"})
        );
        let full = serde_json::to_value(YtdlpDownloadArgs {
            url: "https://youtu.be/x".into(),
            format_id: None,
            args: Some(sv(&["-f", "bestvideo+bestaudio/best/best", "--merge-output-format", "mp4/mkv"])),
            out_dir: "/c/d".into(),
            file_name: Some("Clip".into()),
            job_id: "j2".into(),
            full: Some(true),
        })
        .unwrap();
        assert_eq!(
            full,
            serde_json::json!({
                "url": "https://youtu.be/x",
                "args": ["-f", "bestvideo+bestaudio/best/best", "--merge-output-format", "mp4/mkv"],
                "outDir": "/c/d", "fileName": "Clip", "jobId": "j2", "full": true
            })
        );
        let info = serde_json::to_value(YtdlpInfoArgs { url: "https://youtu.be/x".into(), full: None }).unwrap();
        assert_eq!(info, serde_json::json!({"url": "https://youtu.be/x"}));
        let info = serde_json::to_value(YtdlpInfoArgs { url: "https://youtu.be/x".into(), full: Some(true) }).unwrap();
        assert_eq!(info, serde_json::json!({"url": "https://youtu.be/x", "full": true}));
        assert_eq!(serde_json::to_value(YtdlpStatusArgs {}).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn ytdlp_status_response_shape() {
        let s: YtdlpStatusResponse = serde_json::from_str(
            r#"{"ytdlp":"2026.10.26","ejs":"0.8.0","jsRuntime":"quickjs-ng 0.18.0",
                "ffmpeg":"ffmpeg version 7.1.1","ready":true,"problems":[]}"#,
        )
        .unwrap();
        assert!(s.ready && s.problems.is_empty());
        assert_eq!(s.js_runtime.as_deref(), Some("quickjs-ng 0.18.0"));
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["jsRuntime"], "quickjs-ng 0.18.0");
        assert_eq!(back["ytdlp"], "2026.10.26");
        // Missing pieces: nulls stay null, unknown keys are ignored, a null ytdlp becomes "".
        let s: YtdlpStatusResponse = serde_json::from_str(
            r#"{"ytdlp":null,"ejs":null,"jsRuntime":null,"ffmpeg":null,"ready":false,
                "problems":["qjs_missing","ejs_missing"],"extra":1}"#,
        )
        .unwrap();
        assert_eq!(s.ytdlp, "");
        assert!(!s.ready && s.problems.len() == 2);
        let back = serde_json::to_value(&s).unwrap();
        assert!(back["ejs"].is_null() && back["jsRuntime"].is_null() && back["ffmpeg"].is_null());
        let s: YtdlpStatusResponse = serde_json::from_str("{}").unwrap();
        assert!(!s.ready && s.ytdlp.is_empty());
    }

    #[test]
    fn ytdlp_file_name_rules() {
        assert!(validate_file_name("My video [123]").is_ok());
        assert!(validate_file_name("../x").is_err());
        assert!(validate_file_name("a/b").is_err());
        assert!(validate_file_name("a\\b").is_err());
        assert!(validate_file_name(".hidden").is_err());
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name(&"a".repeat(201)).is_err());
    }

    #[test]
    fn ytdlp_out_dir_rules() {
        assert!(validate_out_dir("/data/x").is_ok());
        assert!(validate_out_dir("rel").is_err());
        assert!(validate_out_dir("/a/../b").is_err());
    }

    #[test]
    fn rejects_unknown_format() {
        assert!(validate("/a/in.mp4", "/a/out.mp3", "mp3").is_err());
    }

    #[test]
    fn rejects_relative_and_parent_paths() {
        assert!(validate("in.mp4", "/a/out.wav", "wav").is_err());
        assert!(validate("/a/../in.mp4", "/a/out.wav", "wav").is_err());
    }

    #[test]
    fn rejects_same_file() {
        assert!(validate("/a/x.m4a", "/a/x.m4a", "m4a").is_err());
    }

    #[test]
    fn accepts_valid_request() {
        assert!(validate("/a/in.mp4", "/a/out.wav", "wav").is_ok());
    }
}
