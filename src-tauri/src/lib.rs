// Tauri shell only: plugin registration, window bootstrap and the thin yt-dlp
// sidecar launcher in `ytdlp.rs`. All extraction/download logic is TypeScript.
#[cfg(desktop)]
use tauri::Manager;

mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Android audio conversion on platform MediaCodec/MediaMuxer (replaces ffmpeg.wasm).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_keepsake_media::init());
    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ytdlp::Jobs::default())
        .manage(ytdlp::VersionCache::default())
        .setup(|app| {
            // The window starts hidden (visible: false) and the frontend calls
            // getCurrentWindow().show() after first paint. Safety net: show it
            // anyway after 4 s so a frontend crash never leaves an invisible app.
            // Desktop only: on Android the activity owns visibility.
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                });
            }
            #[cfg(mobile)]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ytdlp::run_ytdlp,
            ytdlp::cancel_ytdlp,
            ytdlp::binary_status,
            ytdlp::list_installed_browsers
        ])
        .build(tauri::generate_context!())
        .expect("error while building Keepsake")
        .run(|app, event| {
            // Kill running yt-dlp trees when the app exits.
            if let tauri::RunEvent::Exit = event {
                ytdlp::kill_all(app);
            }
        });
}
