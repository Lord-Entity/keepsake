const COMMANDS: &[&str] = &["transcode", "open_file", "ytdlp_info", "ytdlp_download",
    "ytdlp_cancel",
    "ytdlp_mux",
    "gallery_publish",
    "folder_pick",
    "folder_status",
    "folder_save",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
