//! keepsake-media: Android audio transcoding for Keepsake.
//!
//! The work happens in the Kotlin class `app.keepsake.media.KeepsakeMediaPlugin`
//! (android/), on platform MediaExtractor/MediaCodec/MediaMuxer. This crate only
//! registers that class and exposes these commands:
//!
//!   transcode { input, output, format: "wav" | "m4a", kbps? } -> { path }
//!   open_file { path }
//!   ytdlp_info { url } -> { ok, info }                        (TikTok/Instagram, yt-dlp via Chaquopy)
//!   ytdlp_download { url, formatId, outDir, fileName? } -> { path, bytes }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtdlpFormat {
    pub format_id: String,
    pub ext: String,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
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
}

/// https only, host must be an allow-listed domain or a subdomain of one.
fn validate_ytdlp_url(raw: &str) -> Result<(), String> {
    let err = || {
        format!("ytdlp:unsupported_url: Only https TikTok and Instagram links are supported on Android: {raw}")
    };
    let url = tauri::Url::parse(raw).map_err(|_| err())?;
    if url.scheme() != "https" {
        return Err(err());
    }
    let host = url.host_str().ok_or_else(err)?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let ok = YTDLP_HOSTS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")));
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

/// Extracts media info for a TikTok or Instagram link with yt-dlp (Android only).
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
) -> Result<YtdlpDownloadResponse, String> {
    validate_ytdlp_url(&url)?;
    validate_format_id(&format_id)?;
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
        },
    )
    .await
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

/// Initializes the plugin. Register it on mobile only:
/// `#[cfg(mobile)] builder.plugin(tauri_plugin_keepsake_media::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keepsake-media")
        .invoke_handler(tauri::generate_handler![
            transcode,
            open_file,
            ytdlp_info,
            ytdlp_download
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
        validate, validate_file_name, validate_format_id, validate_out_dir, validate_ytdlp_url,
    };

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
            "https://youtube.com/watch?v=x",
            "not a url",
            "",
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
