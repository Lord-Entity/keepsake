package app.keepsake.media

import androidx.core.content.FileProvider

/**
 * Own subclass so the manifest component name differs from the Tauri app template's
 * androidx.core.content.FileProvider entry; two providers with one name fail manifest merge.
 */
class KeepsakeFileProvider : FileProvider()
