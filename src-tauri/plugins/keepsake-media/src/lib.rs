//! keepsake-media: Android audio transcoding for Keepsake.
//!
//! The work happens in the Kotlin class `app.keepsake.media.KeepsakeMediaPlugin`
//! (android/), on platform MediaExtractor/MediaCodec/MediaMuxer. This crate only
//! registers that class and exposes one command:
//!
//!   transcode { input, output, format: "wav" | "m4a", kbps? } -> { path }
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

/// Initializes the plugin. Register it on mobile only:
/// `#[cfg(mobile)] builder.plugin(tauri_plugin_keepsake_media::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keepsake-media")
        .invoke_handler(tauri::generate_handler![transcode])
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
    use super::validate;

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
