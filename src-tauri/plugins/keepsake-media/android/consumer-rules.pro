# Tauri loads the plugin class by name over JNI and calls @Command methods by reflection.
-keep class app.keepsake.media.KeepsakeMediaPlugin { *; }
-keep class app.keepsake.media.TranscodeArgs { *; }
-keep class app.keepsake.media.OpenArgs { *; }
