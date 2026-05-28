const COMMANDS: &[&str] = &[
    "transcode",
    "open_file",
    "ytdlp_status",
    "ytdlp_info",
    "ytdlp_download",
    "ytdlp_cancel",
    "ytdlp_mux",
    "gallery_publish",
    "folder_pick",
    "folder_status",
    "folder_save",
    "editor_probe",
    "editor_export_video",
    "editor_cancel",
    // Not in init()'s generate_handler: the JS addPluginListener / unregister calls for the
    // "keepsake-editor-progress" event go straight to the Kotlin Plugin base class, but they
    // still pass the ACL, so they need allow-register-listener / allow-remove-listener.
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
