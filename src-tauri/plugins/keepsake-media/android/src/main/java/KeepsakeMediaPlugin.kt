package app.keepsake.media

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Environment
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.concurrent.Executors

/** Arguments of the `transcode` command: {input, output, format: "wav" | "m4a", kbps?}. */
@InvokeArg
class TranscodeArgs {
  lateinit var input: String
  lateinit var output: String
  lateinit var format: String
  // Accepted for contract stability; neither M4A (stream copy) nor WAV (PCM) uses a bitrate.
  var kbps: Int? = null
}

/** Arguments of the `openFile` command: {path} (an absolute file path). */
@InvokeArg
class OpenArgs {
  lateinit var path: String
}

/** Arguments of the `ytdlpInfo` command: {url, full?}. `full` enables the bundled JS runtime / ffmpeg route. */
@InvokeArg
class YtdlpInfoArgs {
  lateinit var url: String
  var full: Boolean = false
}

/**
 * Arguments of the `ytdlpDownload` command: {url, formatId?, args?, outDir, fileName?, jobId, full?}.
 * Exactly one of formatId (one concrete id, or two joined by one "+") and args (selection argv) is set.
 */
@InvokeArg
class YtdlpDownloadArgs {
  lateinit var url: String
  var formatId: String? = null
  var args: Array<String>? = null
  lateinit var outDir: String
  var fileName: String? = null
  lateinit var jobId: String
  var full: Boolean = false
}

/** Arguments of the `ytdlpCancel` command: {jobId}. */
@InvokeArg
class YtdlpCancelArgs {
  lateinit var jobId: String
}

/** Arguments of the `ytdlpMux` command: {videoPath, audioPath, outDir, fileName}. */
@InvokeArg
class YtdlpMuxArgs {
  lateinit var videoPath: String
  lateinit var audioPath: String
  lateinit var outDir: String
  lateinit var fileName: String
}

/** Arguments of `galleryPublish`: {src, kind: "video"|"audio"|"image", fileName, mime}. */
@InvokeArg
class GalleryPublishArgs {
  lateinit var src: String
  lateinit var kind: String
  lateinit var fileName: String
  lateinit var mime: String
}

/** Arguments of `folderPick`: {initialUri?}. */
@InvokeArg
class FolderPickArgs {
  var initialUri: String? = null
}

/** Arguments of `folderStatus`: {treeUri}. */
@InvokeArg
class FolderStatusArgs {
  lateinit var treeUri: String
}

/** Arguments of `folderSave`: {src, treeUri, fileName, mime}. */
@InvokeArg
class FolderSaveArgs {
  lateinit var src: String
  lateinit var treeUri: String
  lateinit var fileName: String
  lateinit var mime: String
}

/** Arguments of `editorProbe`: {uri} (content:// URI or absolute file path). */
@InvokeArg
class EditorProbeArgs {
  lateinit var uri: String
}

/** Crop rectangle of `editorExportVideo`, in display-oriented source pixels. */
@InvokeArg
class EditorCropArgs {
  var x: Double = 0.0
  var y: Double = 0.0
  var w: Double = 0.0
  var h: Double = 0.0
}

/** Arguments of `editorExportVideo`: {uri, outPath, crop?, trimStart?, trimEnd?, audio}. Times in seconds. */
@InvokeArg
class EditorExportArgs {
  lateinit var uri: String
  lateinit var outPath: String
  var crop: EditorCropArgs? = null
  var trimStart: Double? = null
  var trimEnd: Double? = null
  var audio: Boolean = true
}

internal class MediaError(message: String, val code: String = "unknown") : Exception(message)

/**
 * Audio conversion on platform codecs only (android.media.*):
 * - m4a: copy the file when it is already an audio-only MP4, otherwise remux the AAC
 *   track into a new MP4 with MediaMuxer. No re-encoding.
 * - wav: decode the first audio track with MediaCodec to 16-bit PCM and write RIFF/WAVE.
 * Everything streams buffer by buffer; the file is never held in memory.
 */
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storage")]
)
class KeepsakeMediaPlugin(private val activity: Activity) : Plugin(activity) {
  // Commands arrive on the main thread; conversions run here. Two workers keep
  // parallel downloads moving without starving the device's codec instances.
  private val worker = Executors.newFixedThreadPool(2)

  @Command
  fun transcode(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(TranscodeArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("Invalid transcode arguments: ${e.message}")
      return
    }
    worker.execute {
      var part: File? = null
      try {
        val format = args.format.lowercase(Locale.ROOT)
        if (format != "wav" && format != "m4a") {
          throw MediaError("Unsupported format \"${args.format}\" on Android. Supported formats: m4a, wav.")
        }
        val input = checkedPath(args.input, "input")
        val output = checkedPath(args.output, "output")
        if (!input.isFile) throw MediaError("Input file not found: ${input.path}")
        if (input == output) throw MediaError("Input and output must be different files.")

        val dir = output.parentFile ?: throw MediaError("Output has no parent folder: ${output.path}")
        if (!dir.isDirectory && !dir.mkdirs()) throw MediaError("Can't create folder ${dir.path}")
        val tmp = File(dir, output.name + ".part")
        part = tmp
        tmp.delete()

        when (format) {
          "m4a" -> toM4a(input, tmp)
          else -> toWav(input, tmp)
        }

        if (output.exists() && !output.delete()) throw MediaError("Can't replace ${output.path}")
        if (!tmp.renameTo(output)) throw MediaError("Can't move the converted file to ${output.path}")
        part = null

        val ret = JSObject()
        ret.put("path", output.absolutePath)
        invoke.resolve(ret)
      } catch (e: Throwable) {
        part?.delete()
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  /**
   * Opens a finished download in another app. Other apps can't read a raw file path on
   * Android 7+, so the file is shared as a content:// URI through FileProvider. The path
   * must sit inside the same allowed roots as transcode.
   */
  @Command
  fun openFile(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(OpenArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("Invalid open arguments: ${e.message}")
      return
    }
    try {
      val isContent = args.path.startsWith("content://")
      val uri: Uri
      val name: String
      if (isContent) {
        val parsed = try { Uri.parse(args.path) } catch (e: Exception) { throw MediaError("Invalid file address.", "bad_uri") }
        when (parsed.authority) {
          // Gallery downloads (galleryPublish): read-only MediaStore links, no tree check.
          MediaStore.AUTHORITY -> {
            uri = parsed
            name = checkedMediaName(parsed)
          }
          // Our own FileProvider (API 24-28 Gallery fallback). It only exposes keepsake_paths roots.
          fileProviderAuthority() -> {
            uri = parsed
            name = parsed.lastPathSegment ?: "file"
          }
          // Folder-mode downloads: SAF document inside the persisted tree grant.
          else -> {
            uri = KeepsakeSaf.checkedDocUri(activity, args.path)
            name = uri.lastPathSegment ?: "file"
          }
        }
      } else {
        val file = checkedPath(args.path, "file")
        if (!file.isFile) throw MediaError("File not found: ${file.path}")
        uri = FileProvider.getUriForFile(activity, fileProviderAuthority(), file)
        name = file.name
      }
      val type = if (isContent) activity.contentResolver.getType(uri) ?: mimeFor(name) else mimeFor(name)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, type)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      if (intent.resolveActivity(activity.packageManager) == null) {
        throw MediaError("No app on this device can open $name.")
      }
      activity.startActivity(intent)
      invoke.resolve(JSObject())
    } catch (e: Throwable) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  private fun fileProviderAuthority(): String = "${activity.packageName}.keepsake.fileprovider"

  /**
   * Checks that a content://media/... row still exists and is readable by this app
   * (on API 29+ the query only returns rows the app owns or may read). Returns its display name.
   */
  private fun checkedMediaName(uri: Uri): String {
    if (uri.scheme != "content") throw MediaError("Invalid file address.", "bad_uri")
    val cursor = try {
      activity.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
    } catch (e: SecurityException) {
      throw MediaError("Keepsake has no access to that Gallery item.", "permission")
    } catch (e: IllegalArgumentException) {
      throw MediaError("Invalid Gallery address.", "bad_uri")
    }
    cursor?.use { c ->
      if (c.moveToFirst()) return c.getString(0) ?: (uri.lastPathSegment ?: "file")
    }
    throw MediaError("That Gallery item no longer exists.", "not_found")
  }

  /**
   * Source of galleryPublish / folderSave. These commands delete (or move) their source, so it must
   * be a staging file under cacheDir/gallery-<id>/; anything else is refused before any delete.
   */
  private fun stagedSource(raw: String): File {
    val f = checkedPath(raw, "source")
    val cache = activity.cacheDir.canonicalFile
    val rel = f.path.removePrefix(cache.path + File.separator)
    val ok = rel != f.path && rel.startsWith("gallery-") && rel.contains(File.separator)
    if (!ok) throw MediaError("The source must be a staged download in the app cache: $raw")
    return f
  }

  /**
   * Self-check of the bundled yt-dlp route. Resolves {ytdlp, ejs, jsRuntime, ffmpeg, ready, problems};
   * rejects "ytdlp:unknown: <message>" only when Python itself fails.
   */
  @Command
  fun ytdlpStatus(invoke: Invoke) {
    KeepsakeYtdlp.infoExecutor.execute {
      try {
        val r = KeepsakeYtdlp.status(activity)
        invoke.resolve(JSObject(r.toString()))
      } catch (e: Throwable) {
        invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}")
      }
    }
  }

  /** TikTok/Instagram/YouTube metadata through yt-dlp (Python). Resolves {ok, info}; rejects "ytdlp:<code>: <message>". */
  @Command
  fun ytdlpInfo(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(YtdlpInfoArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_info arguments: ${e.message}")
      return
    }
    KeepsakeYtdlp.infoExecutor.execute {
      try {
        val r = KeepsakeYtdlp.info(activity, args.url, args.full)
        invoke.resolve(JSObject(r.toString()))
      } catch (e: YtdlpError) {
        invoke.reject("ytdlp:${e.code}: ${e.message}")
      } catch (e: Throwable) {
        invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}")
      }
    }
  }

  /**
   * Downloads into outDir: one concrete yt-dlp format (formatId, "a" or "a+b") or a selection argv (args).
   * Resolves {path, bytes}; rejects "ytdlp:<code>: <message>".
   */
  @Command
  fun ytdlpDownload(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(YtdlpDownloadArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_download arguments: ${e.message}")
      return
    }
    val formatId = args.formatId?.takeIf { it.isNotEmpty() }
    val selection = args.args?.toList()?.takeIf { it.isNotEmpty() }
    if ((formatId == null) == (selection == null)) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_download arguments: exactly one of formatId and args is required.")
      return
    }
    KeepsakeYtdlp.executor.execute {
      try {
        val dir = checkedPath(args.outDir, "output folder")
        if (!dir.isDirectory && !dir.mkdirs()) throw MediaError("Can't create folder ${dir.path}", "permission")
        val r = KeepsakeYtdlp.download(
          activity, args.url, formatId, dir.path, args.fileName, args.jobId, selection, args.full,
        )
        val ret = JSObject()
        ret.put("path", r.getString("path"))
        ret.put("bytes", r.getLong("bytes"))
        invoke.resolve(ret)
      } catch (e: YtdlpError) {
        invoke.reject("ytdlp:${e.code}: ${e.message}")
      } catch (e: MediaError) {
        invoke.reject("ytdlp:${e.code}: ${e.message}")
      } catch (e: Throwable) {
        invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}")
      }
    }
  }

  /** Sets the cancel flag of a running download. Resolves {}. */
  @Command
  fun ytdlpCancel(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(YtdlpCancelArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_cancel arguments: ${e.message}")
      return
    }
    // Own thread: must not queue behind running downloads.
    Thread {
      try {
        KeepsakeYtdlp.cancel(activity, args.jobId)
        invoke.resolve(JSObject())
      } catch (e: Throwable) {
        invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}")
      }
    }.start()
  }

  /** Muxes a video-only and an audio-only file into an MP4. Resolves {path, bytes}; rejects "ytdlp:<code>: <message>". */
  @Command
  fun ytdlpMux(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(YtdlpMuxArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("ytdlp:unknown: Invalid ytdlp_mux arguments: ${e.message}")
      return
    }
    KeepsakeYtdlp.executor.execute {
      try {
        val video = checkedPath(args.videoPath, "video")
        val audio = checkedPath(args.audioPath, "audio")
        val dir = checkedPath(args.outDir, "output folder")
        val r = KeepsakeYtdlp.mux(activity, video, audio, dir, args.fileName)
        val ret = JSObject()
        ret.put("path", r.getString("path"))
        ret.put("bytes", r.getLong("bytes"))
        invoke.resolve(ret)
      } catch (e: YtdlpError) {
        invoke.reject("ytdlp:${e.code}: ${e.message}")
      } catch (e: MediaError) {
        invoke.reject("ytdlp:${e.code}: ${e.message}")
      } catch (e: Throwable) {
        invoke.reject("ytdlp:unknown: ${e.message ?: e.toString()}")
      }
    }
  }

  // ---------------- gallery + folder ----------------

  private fun galleryReject(invoke: Invoke, code: String, msg: String, kept: String? = null) {
    invoke.reject("gallery:$code: $msg" + (if (kept != null) " kept=$kept" else ""))
  }

  /** Publishes src into the Gallery. On API 24-28 asks for WRITE_EXTERNAL_STORAGE first. */
  @Command
  fun galleryPublish(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(GalleryPublishArgs::class.java)
    } catch (e: Exception) {
      galleryReject(invoke, "unknown", "Invalid gallery_publish arguments: ${e.message}")
      return
    }
    if (Build.VERSION.SDK_INT <= 28 && getPermissionState("storage") != PermissionState.GRANTED) {
      requestPermissionForAlias("storage", invoke, "galleryPermissionResult")
      return
    }
    runGalleryPublish(invoke, args)
  }

  @PermissionCallback
  fun galleryPermissionResult(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(GalleryPublishArgs::class.java)
    } catch (e: Exception) {
      galleryReject(invoke, "unknown", "Invalid gallery_publish arguments: ${e.message}")
      return
    }
    if (getPermissionState("storage") == PermissionState.GRANTED) {
      runGalleryPublish(invoke, args)
      return
    }
    worker.execute {
      val kept = try {
        KeepsakeGallery.keepForRecovery(activity, stagedSource(args.src))
      } catch (e: Throwable) {
        null
      }
      // kept= only when the file really moved; otherwise it stays in staging and TS must keep that dir.
      if (kept != null) {
        galleryReject(invoke, "permission", "Storage permission was denied.", kept.absolutePath)
      } else {
        galleryReject(invoke, "permission", "Storage permission was denied. The file was left in staging.")
      }
    }
  }

  private fun runGalleryPublish(invoke: Invoke, args: GalleryPublishArgs) {
    worker.execute {
      var src: File? = null
      try {
        src = stagedSource(args.src)
        if (!src.isFile) throw MediaError("Source file is missing: ${src.path}", "unknown")
        val r = KeepsakeGallery.publish(activity, src, args.kind, args.fileName, args.mime)
        invoke.resolve(JSObject(r.toString()))
      } catch (e: Throwable) {
        // Codes are limited to no_space, permission, unknown (TS parses them).
        val code = (e as? MediaError)?.code?.takeIf { it == "no_space" || it == "permission" } ?: "unknown"
        val msg = e.message ?: e.toString()
        // src is only set once stagedSource accepted it, so a non-staged file is never moved.
        val staged = src?.takeIf { it.isFile }
        val kept = staged?.let { KeepsakeGallery.keepForRecovery(activity, it) }
        when {
          kept != null -> galleryReject(invoke, code, msg, kept.absolutePath)
          staged != null -> galleryReject(invoke, code, "$msg (the file was left in staging)")
          else -> galleryReject(invoke, code, msg)
        }
      }
    }
  }

  private fun folderReject(invoke: Invoke, e: Throwable) {
    val code = when (e) {
      // Only the documented folder codes reach TS; anything else (e.g. "unknown") becomes io.
      is MediaError -> e.code.takeIf { it in FOLDER_CODES } ?: "io"
      is SecurityException -> "permission"
      else -> "io"
    }
    invoke.reject("folder:$code: ${e.message ?: e.toString()}")
  }

  /** Opens the system folder picker. Resolves {uri, name}; both null on cancel. */
  @Command
  fun folderPick(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(FolderPickArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("folder:bad_uri: Invalid folder_pick arguments: ${e.message}")
      return
    }
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
      )
      val initial = args.initialUri
      if (!initial.isNullOrEmpty() && initial.startsWith("content://") && Build.VERSION.SDK_INT >= 26) {
        intent.putExtra("android.provider.extra.INITIAL_URI", Uri.parse(initial))
      }
      startActivityForResult(invoke, intent, "folderPickResult")
    } catch (e: Throwable) {
      folderReject(invoke, e)
    }
  }

  @ActivityCallback
  fun folderPickResult(invoke: Invoke, result: ActivityResult) {
    val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    if (uri == null) {
      val ret = JSObject()
      ret.put("uri", JSONObject.NULL)
      ret.put("name", JSONObject.NULL)
      invoke.resolve(ret)
      return
    }
    try {
      KeepsakeSaf.persistTree(activity, uri)
      val ret = JSObject()
      ret.put("uri", uri.toString())
      ret.put("name", KeepsakeSaf.treeName(activity, uri))
      invoke.resolve(ret)
    } catch (e: Throwable) {
      folderReject(invoke, e)
    }
  }

  /** Resolves {ok, name}: whether the persisted write grant for treeUri still exists. */
  @Command
  fun folderStatus(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(FolderStatusArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("folder:bad_uri: Invalid folder_status arguments: ${e.message}")
      return
    }
    worker.execute {
      try {
        val uri = KeepsakeSaf.checkedTreeUri(activity, args.treeUri)
        val ok = KeepsakeSaf.hasWriteGrant(activity, uri)
        val ret = JSObject()
        ret.put("ok", ok)
        ret.put("name", if (ok) KeepsakeSaf.treeName(activity, uri) else "")
        invoke.resolve(ret)
      } catch (e: Throwable) {
        folderReject(invoke, e)
      }
    }
  }

  /** Copies src into the chosen tree, then deletes src. Resolves {uri, name, bytes}. */
  @Command
  fun folderSave(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(FolderSaveArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("folder:bad_uri: Invalid folder_save arguments: ${e.message}")
      return
    }
    worker.execute {
      try {
        val src = try {
          stagedSource(args.src)
        } catch (e: MediaError) {
          throw MediaError(e.message ?: "Invalid source.", "source_missing")
        }
        if (!src.isFile) throw MediaError("Source file is missing: ${src.path}", "source_missing")
        val tree = KeepsakeSaf.checkedTreeUri(activity, args.treeUri)
        val r = KeepsakeSaf.copyToTree(activity, src, tree, args.fileName, args.mime)
        src.delete()
        invoke.resolve(JSObject(r.toString()))
      } catch (e: Throwable) {
        folderReject(invoke, e)
      }
    }
  }

  // ---------------- editor (KeepsakeEditor, Media3 Transformer) ----------------

  private fun editorReject(invoke: Invoke, e: Throwable) {
    val code = when (e) {
      is EditorError -> e.code.takeIf { it in EDITOR_CODES } ?: "export_failed"
      is SecurityException -> "permission"
      else -> "export_failed"
    }
    invoke.reject("editor:$code: ${e.message ?: e.toString()}")
  }

  /** The video to edit: a content:// URI (picker grant) or a file inside the allowed roots. */
  private fun editorSource(raw: String): Uri {
    if (raw.startsWith("content://")) {
      val u = try { Uri.parse(raw) } catch (e: Exception) { null }
      if (u == null || u.scheme != "content" || u.authority.isNullOrEmpty()) {
        throw EditorError("Invalid video address.", "unsupported")
      }
      return u
    }
    val f = try {
      checkedPath(raw, "video")
    } catch (e: MediaError) {
      throw EditorError(e.message ?: "The video path is not allowed.", "permission")
    }
    if (!f.isFile) throw EditorError("Video file not found: ${f.path}", "unsupported")
    return Uri.fromFile(f)
  }

  /**
   * Export target: an .mp4 inside the allowed roots (app cache for gallery/folder staging, or the
   * legacy-mode Downloads/save folder). Canonical, so no ".." or symlink escape.
   */
  private fun editorOutput(raw: String): File {
    val c = try {
      checkedPath(raw, "output")
    } catch (e: MediaError) {
      throw EditorError(e.message ?: "The output path is not allowed.", "permission")
    }
    if (!c.name.lowercase(Locale.ROOT).endsWith(".mp4")) {
      throw EditorError("The output must be an .mp4 file: $raw", "unsupported")
    }
    return c
  }

  /** Resolves {width, height, duration (s), hasAudio, rotation}; width/height are display-oriented. */
  @Command
  fun editorProbe(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(EditorProbeArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("editor:unsupported: Invalid editor_probe arguments: ${e.message}")
      return
    }
    worker.execute {
      try {
        val p = KeepsakeEditor.probe(activity, editorSource(args.uri))
        val ret = JSObject()
        ret.put("width", p.width)
        ret.put("height", p.height)
        ret.put("duration", p.durationMs / 1000.0)
        ret.put("hasAudio", p.hasAudio)
        ret.put("rotation", p.rotation)
        invoke.resolve(ret)
      } catch (e: Throwable) {
        editorReject(invoke, e)
      }
    }
  }

  /**
   * Crops / trims / mutes a video into an H.264+AAC MP4 at outPath. Resolves {path}; rejects
   * "editor:<code>: <message>". Emits "keepsake-editor-progress" {fraction} while running.
   */
  @Command
  fun editorExportVideo(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(EditorExportArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("editor:unsupported: Invalid editor_export_video arguments: ${e.message}")
      return
    }
    worker.execute {
      try {
        val src = editorSource(args.uri)
        val out = editorOutput(args.outPath)
        val crop = args.crop?.let { KeepsakeEditor.CropRect(it.x, it.y, it.w, it.h) }
        val req = KeepsakeEditor.Request(src, out, crop, args.trimStart, args.trimEnd, args.audio)
        KeepsakeEditor.export(
          activity,
          req,
          { fraction ->
            val ev = JSObject()
            ev.put("fraction", fraction)
            trigger(EDITOR_PROGRESS_EVENT, ev)
          },
          { file ->
            val ret = JSObject()
            ret.put("path", file.absolutePath)
            invoke.resolve(ret)
          },
          { err -> editorReject(invoke, err) },
        )
      } catch (e: Throwable) {
        editorReject(invoke, e)
      }
    }
  }

  /** Cancels the running export (its call rejects with editor:cancelled). Resolves {}. */
  @Command
  fun editorCancel(invoke: Invoke) {
    try {
      KeepsakeEditor.cancel()
      invoke.resolve(JSObject())
    } catch (e: Throwable) {
      editorReject(invoke, e)
    }
  }

  private fun mimeFor(name: String): String =
    when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
      "mp4" -> "video/mp4"
      "webm" -> "video/webm"
      "mkv" -> "video/x-matroska"
      "m4a" -> "audio/mp4"
      "mp3" -> "audio/mpeg"
      "wav" -> "audio/wav"
      "opus", "ogg" -> "audio/ogg"
      "flac" -> "audio/flac"
      "jpg", "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "webp" -> "image/webp"
      else -> "*/*"
    }

  // ---------------- path checks ----------------

  /** App-private cache/files plus the download folders Keepsake may write to. */
  @Suppress("DEPRECATION")
  private fun allowedRoots(): List<File> {
    val roots = mutableListOf<File?>(
      activity.cacheDir,
      activity.filesDir,
      activity.externalCacheDir,
      // Parent of Tauri's $DOWNLOAD, $AUDIO and $VIDEO on Android.
      activity.getExternalFilesDir(null),
    )
    for (type in arrayOf(Environment.DIRECTORY_DOWNLOADS, Environment.DIRECTORY_MUSIC, Environment.DIRECTORY_MOVIES, Environment.DIRECTORY_PICTURES)) {
      roots.add(Environment.getExternalStoragePublicDirectory(type))
    }
    return roots.filterNotNull().map { it.canonicalFile }
  }

  private fun checkedPath(raw: String, label: String): File {
    val f = File(raw)
    if (!f.isAbsolute) throw MediaError("The $label path must be absolute: $raw")
    // canonicalFile resolves "..", "." and symlinks, so a path cannot escape its root.
    val c = f.canonicalFile
    val ok = allowedRoots().any { root -> c.path == root.path || c.path.startsWith(root.path + File.separator) }
    if (!ok) throw MediaError("The $label path is outside the app cache and download folders: $raw")
    return c
  }

  // ---------------- m4a ----------------

  private fun toM4a(input: File, out: File) {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(input.absolutePath)
      val track = findAudioTrack(ex)
      val fmt = ex.getTrackFormat(track)
      val mime = fmt.getString(MediaFormat.KEY_MIME) ?: "unknown"
      if (mime != MediaFormat.MIMETYPE_AUDIO_AAC) {
        throw MediaError("Can't save $mime audio as M4A without re-encoding. Choose WAV instead.")
      }
      if (ex.trackCount == 1 && isMp4(input)) {
        copyFile(input, out)
        return
      }
      remuxAudio(ex, track, fmt, out)
    } finally {
      ex.release()
    }
  }

  /** Copies the AAC samples of [track] into a new MP4 without decoding. */
  private fun remuxAudio(ex: MediaExtractor, track: Int, fmt: MediaFormat, out: File) {
    val muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    try {
      ex.selectTrack(track)
      val dst = muxer.addTrack(fmt)
      muxer.start()
      val cap = if (fmt.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        maxOf(fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE), 256 * 1024)
      } else {
        1024 * 1024
      }
      val buf = ByteBuffer.allocateDirect(cap)
      val info = MediaCodec.BufferInfo()
      var samples = 0
      while (true) {
        buf.clear()
        val n = ex.readSampleData(buf, 0)
        if (n < 0) break
        val flags = if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        info.set(0, n, ex.sampleTime, flags)
        muxer.writeSampleData(dst, buf, info)
        samples++
        ex.advance()
      }
      if (samples == 0) throw MediaError("The input has no audio samples.")
      muxer.stop()
    } finally {
      muxer.release()
    }
  }

  // ---------------- wav ----------------

  private fun toWav(input: File, out: File) {
    val ex = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      ex.setDataSource(input.absolutePath)
      val track = findAudioTrack(ex)
      val fmt = ex.getTrackFormat(track)
      val mime = fmt.getString(MediaFormat.KEY_MIME) ?: throw MediaError("The audio track has no MIME type.")
      ex.selectTrack(track)

      val dec = try {
        MediaCodec.createDecoderByType(mime)
      } catch (e: Exception) {
        throw MediaError("This device has no decoder for $mime audio.")
      }
      codec = dec
      dec.configure(fmt, null, null, 0)
      dec.start()

      var sampleRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var encoding = AudioFormat.ENCODING_PCM_16BIT
      var dataBytes = 0L

      BufferedOutputStream(FileOutputStream(out), 64 * 1024).use { os ->
        os.write(ByteArray(WAV_HEADER_SIZE)) // placeholder, patched after decoding
        val scratch = ByteArray(64 * 1024)
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var idleAfterInput = 0

        while (true) {
          if (!inputDone) {
            val i = dec.dequeueInputBuffer(TIMEOUT_US)
            if (i >= 0) {
              val ib = dec.getInputBuffer(i) ?: throw MediaError("Decoder returned no input buffer.")
              val n = ex.readSampleData(ib, 0)
              if (n < 0) {
                dec.queueInputBuffer(i, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                dec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                ex.advance()
              }
            }
          }

          val o = dec.dequeueOutputBuffer(info, TIMEOUT_US)
          if (o >= 0) {
            idleAfterInput = 0
            if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              val ob = dec.getOutputBuffer(o) ?: throw MediaError("Decoder returned no output buffer.")
              ob.position(info.offset)
              ob.limit(info.offset + info.size)
              dataBytes += writePcm(ob, encoding, os, scratch)
              if (dataBytes > MAX_WAV_DATA) throw MediaError("The audio is too long for a WAV file (4 GB limit).")
            }
            dec.releaseOutputBuffer(o, false)
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
          } else if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            val f = dec.outputFormat
            val rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val ch = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val enc = if (f.containsKey(MediaFormat.KEY_PCM_ENCODING)) f.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
            if (dataBytes > 0 && (rate != sampleRate || ch != channels)) {
              throw MediaError("The audio format changed mid-stream; can't write a single WAV.")
            }
            sampleRate = rate
            channels = ch
            encoding = enc
          } else if (inputDone) {
            // INFO_TRY_AGAIN_LATER after end of input: guard against a decoder that never signals EOS.
            if (++idleAfterInput > MAX_IDLE_POLLS) throw MediaError("The audio decoder stopped responding.")
          }
        }
      }

      if (dataBytes == 0L) throw MediaError("The input has no decodable audio.")
      RandomAccessFile(out, "rw").use { raf ->
        raf.seek(0)
        raf.write(wavHeader(dataBytes, sampleRate, channels))
      }
    } finally {
      codec?.let {
        try { it.stop() } catch (e: Exception) { /* not started */ }
        it.release()
      }
      ex.release()
    }
  }

  /** Writes one decoder buffer as 16-bit little-endian PCM; returns the bytes written. */
  private fun writePcm(src: ByteBuffer, encoding: Int, os: OutputStream, scratch: ByteArray): Long {
    when (encoding) {
      AudioFormat.ENCODING_PCM_16BIT -> {
        // Decoder output is native order, which is little-endian on every Android ABI.
        var written = 0L
        while (src.hasRemaining()) {
          val n = minOf(src.remaining(), scratch.size)
          src.get(scratch, 0, n)
          os.write(scratch, 0, n)
          written += n
        }
        return written
      }
      AudioFormat.ENCODING_PCM_FLOAT -> {
        val floats = src.slice().order(ByteOrder.nativeOrder()).asFloatBuffer()
        var written = 0L
        while (floats.hasRemaining()) {
          val count = minOf(floats.remaining(), scratch.size / 2)
          for (k in 0 until count) {
            val v = (floats.get().coerceIn(-1f, 1f) * 32767f).toInt()
            scratch[2 * k] = (v and 0xFF).toByte()
            scratch[2 * k + 1] = ((v shr 8) and 0xFF).toByte()
          }
          os.write(scratch, 0, count * 2)
          written += count * 2
        }
        return written
      }
      else -> throw MediaError("Unsupported decoder PCM encoding $encoding.")
    }
  }

  // ---------------- helpers ----------------

  private fun findAudioTrack(ex: MediaExtractor): Int {
    for (i in 0 until ex.trackCount) {
      val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith("audio/")) return i
    }
    throw MediaError("No audio track found in the input file.")
  }

  /** ISO BMFF files carry "ftyp" at bytes 4..7. */
  private fun isMp4(f: File): Boolean {
    val head = ByteArray(8)
    FileInputStream(f).use { if (it.read(head) < 8) return false }
    return head[4] == 'f'.code.toByte() && head[5] == 't'.code.toByte() &&
      head[6] == 'y'.code.toByte() && head[7] == 'p'.code.toByte()
  }

  private fun copyFile(src: File, dst: File) {
    FileInputStream(src).use { input ->
      FileOutputStream(dst).use { output -> input.copyTo(output, 64 * 1024) }
    }
  }

  private fun wavHeader(dataBytes: Long, sampleRate: Int, channels: Int): ByteArray {
    val blockAlign = channels * 2
    val b = ByteBuffer.allocate(WAV_HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN)
    b.put(ascii("RIFF"))
    b.putInt((36L + dataBytes).toInt()) // unsigned 32-bit; bounded by MAX_WAV_DATA
    b.put(ascii("WAVE"))
    b.put(ascii("fmt "))
    b.putInt(16) // PCM fmt chunk size
    b.putShort(1) // audio format: PCM
    b.putShort(channels.toShort())
    b.putInt(sampleRate)
    b.putInt(sampleRate * blockAlign) // byte rate
    b.putShort(blockAlign.toShort())
    b.putShort(16) // bits per sample
    b.put(ascii("data"))
    b.putInt(dataBytes.toInt())
    return b.array()
  }

  private fun ascii(s: String): ByteArray = s.toByteArray(Charsets.US_ASCII)

  private companion object {
    const val WAV_HEADER_SIZE = 44
    const val TIMEOUT_US = 10_000L
    const val MAX_IDLE_POLLS = 500 // x 10 ms = 5 s without output after end of input
    const val MAX_WAV_DATA = 0xFFFFFFFFL - 36L
    val FOLDER_CODES = setOf("permission", "not_found", "no_space", "source_missing", "bad_uri", "io")
    val EDITOR_CODES = setOf("unsupported", "cancelled", "no_space", "permission", "export_failed")
    const val EDITOR_PROGRESS_EVENT = "keepsake-editor-progress"
  }
}
