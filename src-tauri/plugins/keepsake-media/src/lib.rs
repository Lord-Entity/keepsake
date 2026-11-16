//! keepsake-media: Android audio transcoding for Keepsake.
//!
//! The work happens in the Kotlin class `app.keepsake.media.KeepsakeMediaPlugin`
//! (android/), on platform MediaExtractor/MediaCodec/MediaMuxer. This crate only
//! registers that class and exposes these commands:
//!
//!   transcode { input, output, format: "wav" | "m4a", kbps? } -> { path }
//!   open_file { path }                                        (absolute file path or content:// URI)
//!   ytdlp_info { url } -> { ok, info }                        (TikTok/Instagram/YouTube, yt-dlp via Chaquopy)
//!   ytdlp_download { url, formatId, outDir, fileName?, jobId } -> { path, bytes }
//!   ytdlp_cancel { jobId } -> {}
//!   ytdlp_mux { videoPath, audioPath, outDir, fileName } -> { path, bytes }
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

#[derive(Debug, Serialize)]
struct YtdlpInfoArgs {
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpDownloadArgs {
    url: String,
    format_id: String,
    out_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    job_id: String,
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

fn validate_format_id(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.chars().count() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c));
    if ok {
        Ok(())
    } else {
        Err(format!("ytdlp:unknown: Invalid format id: {s:?}"))
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

/// Extracts media info for a TikTok, Instagram or YouTube link with yt-dlp (Android only).
#[tauri::command]
async fn ytdlp_info<R: Runtime>(app: AppHandle<R>, url: String) -> Result<YtdlpInfoResponse, String> {
    validate_ytdlp_url(&url)?;
    run_ytdlp_info(app, YtdlpInfoArgs { url }).await
}

/// Downloads ONE concrete yt-dlp format into `out_dir` (Android only).
#[tauri::command]
async fn ytdlp_download<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    format_id: String,
    out_dir: String,
    file_name: Option<String>,
    job_id: String,
) -> Result<YtdlpDownloadResponse, String> {
    validate_ytdlp_url(&url)?;
    validate_format_id(&format_id)?;
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
            out_dir,
            file_name,
            job_id,
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

/// Initializes the plugin. Register it on mobile only:
/// `#[cfg(mobile)] builder.plugin(tauri_plugin_keepsake_media::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keepsake-media")
        .invoke_handler(tauri::generate_handler![
            transcode,
            open_file,
            ytdlp_info,
            ytdlp_download,
            ytdlp_cancel,
            ytdlp_mux,
            gallery_publish,
            folder_pick,
            folder_status,
            folder_save
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
        validate_out_dir, validate_ytdlp_url,
    };
    use super::{
        validate_content_uri, validate_folder_save, validate_gallery_publish, validate_media_kind,
        validate_tree_uri,
    };

    const TREE: &str = "content://com.android.externalstorage.documents/tree/primary%3AMovies";

    // serde_json is not a dependency of this crate, so build the input with serde's own
    // value deserializer instead.
    mod fmt_de {
        use super::super::YtdlpFormat;
        use serde::de::value::{Error, MapDeserializer};
        use serde::de::{Deserialize, Deserializer, IntoDeserializer, Visitor};

        #[derive(Clone, Copy)]
        pub enum V {
            S(&'static str),
            F(f64),
            U(u64),
            Null,
        }
        pub struct VD(V);
        impl<'de> Deserializer<'de> for VD {
            type Error = Error;
            fn deserialize_any<X: Visitor<'de>>(self, v: X) -> Result<X::Value, Error> {
                match self.0 {
                    V::S(s) => v.visit_str(s),
                    V::F(f) => v.visit_f64(f),
                    V::U(u) => v.visit_u64(u),
                    V::Null => v.visit_unit(),
                }
            }
            fn deserialize_option<X: Visitor<'de>>(self, v: X) -> Result<X::Value, Error> {
                match self.0 {
                    V::Null => v.visit_none(),
                    _ => v.visit_some(self),
                }
            }
            serde::forward_to_deserialize_any! {
                bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes
                byte_buf unit unit_struct newtype_struct seq tuple tuple_struct map struct
                enum identifier ignored_any
            }
        }
        impl<'de> IntoDeserializer<'de, Error> for V {
            type Deserializer = VD;
            fn into_deserializer(self) -> VD {
                VD(self)
            }
        }

        pub fn parse(pairs: Vec<(&'static str, V)>) -> YtdlpFormat {
            let d = MapDeserializer::<_, Error>::new(pairs.into_iter());
            YtdlpFormat::deserialize(d).expect("deserialize")
        }
    }

    #[test]
    fn ytdlp_format_keeps_bitrate_and_width() {
        use fmt_de::{parse, V};
        let f = parse(vec![
            ("format_id", V::S("137")),
            ("ext", V::S("mp4")),
            ("protocol", V::S("https")),
            ("height", V::U(1080)),
            ("width", V::U(1920)),
            ("tbr", V::F(4321.5)),
            ("abr", V::F(128.0)),
        ]);
        assert_eq!(f.width, Some(1920));
        assert_eq!(f.tbr, Some(4321.5));
        assert_eq!(f.abr, Some(128.0));
        assert_eq!(f.height, Some(1080));
    }

    #[test]
    fn ytdlp_format_missing_and_null_optionals_parse() {
        use fmt_de::{parse, V};
        let base = vec![
            ("format_id", V::S("18")),
            ("ext", V::S("mp4")),
            ("protocol", V::S("https")),
        ];
        let f = parse(base.clone());
        assert!(f.tbr.is_none() && f.abr.is_none() && f.width.is_none());
        let mut nulls = base;
        nulls.extend([("tbr", V::Null), ("abr", V::Null), ("width", V::Null)]);
        let f = parse(nulls);
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
        assert!(validate_format_id("dash-1+2").is_err());
        assert!(validate_format_id("").is_err());
        assert!(validate_format_id(&"a".repeat(64)).is_ok());
        assert!(validate_format_id(&"a".repeat(65)).is_err());
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
