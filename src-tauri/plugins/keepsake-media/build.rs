const COMMANDS: &[&str] = &["transcode", "open_file", "ytdlp_info", "ytdlp_download",
    "ytdlp_cancel",
    "ytdlp_mux",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
