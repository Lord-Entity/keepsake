const COMMANDS: &[&str] = &["transcode", "open_file"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
