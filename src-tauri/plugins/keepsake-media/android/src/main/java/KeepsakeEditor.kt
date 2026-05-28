package app.keepsake.media

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.system.ErrnoException
import android.system.OsConstants
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Crop
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import java.io.File
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Editor failure. [code] is one of unsupported, cancelled, no_space, permission, export_failed. */
internal class EditorError(message: String, val code: String) : Exception(message)

/**
 * Video crop + trim + mute export on AndroidX Media3 Transformer (hardware codecs, H.264/AAC MP4 out).
 *
 * One export at a time. Everything that touches a Transformer runs on [handler]'s thread, which is
 * also the Transformer's application looper, so [active] needs no locking.
 */
@androidx.annotation.OptIn(UnstableApi::class)
internal object KeepsakeEditor {
  class CropRect(val x: Double, val y: Double, val w: Double, val h: Double)

  class Request(
    val source: Uri,
    val out: File,
    val crop: CropRect?,
    val trimStart: Double?,
    val trimEnd: Double?,
    val audio: Boolean,
  )

  /** Display-oriented size (rotation already applied), duration in ms. */
  class Probe(val width: Int, val height: Int, val durationMs: Long, val hasAudio: Boolean, val rotation: Int)

  private class Job(
    val out: File,
    val onProgress: (Double) -> Unit,
    val onDone: (File) -> Unit,
    val onError: (Throwable) -> Unit,
  ) {
    var transformer: Transformer? = null
    var lastFraction = -1.0
  }

  private const val POLL_MS = 250L
  private const val MIN_CLIP_MS = 100L
  private const val MIN_FREE_BYTES = 32L * 1024 * 1024
  private const val MIN_SIDE = 16

  private val thread: HandlerThread by lazy { HandlerThread("keepsake-editor").also { it.start() } }
  private val handler: Handler by lazy { Handler(thread.looper) }

  // Only read or written on handler's thread.
  private var active: Job? = null

  /** Reads size, rotation, duration and audio presence. Blocking; call off the main thread. */
  fun probe(context: Context, uri: Uri): Probe {
    val r = MediaMetadataRetriever()
    try {
      try {
        r.setDataSource(context, uri)
      } catch (e: SecurityException) {
        throw EditorError("Keepsake has no access to this video.", "permission")
      } catch (e: Exception) {
        throw EditorError("This file can't be read as a video: ${e.message ?: e.toString()}", "unsupported")
      }
      val rawW = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val rawH = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val hasVideo = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
      if (!hasVideo || rawW <= 0 || rawH <= 0) throw EditorError("This file has no video track.", "unsupported")
      val rotation = ((r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0) % 360 + 360) % 360
      val swap = rotation == 90 || rotation == 270
      val durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val hasAudio = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
      return Probe(if (swap) rawH else rawW, if (swap) rawW else rawH, maxOf(durationMs, 0L), hasAudio, rotation)
    } finally {
      try { r.release() } catch (e: Exception) { /* already released */ }
    }
  }

  /**
   * Starts an export. Exactly one of [onDone] / [onError] is called, on the editor thread.
   * [onProgress] gets fractions in 0..1 while the export runs.
   */
  fun export(
    context: Context,
    req: Request,
    onProgress: (Double) -> Unit,
    onDone: (File) -> Unit,
    onError: (Throwable) -> Unit,
  ) {
    val app = context.applicationContext
    handler.post {
      if (active != null) {
        safely { onError(EditorError("Another video export is already running.", "export_failed")) }
        return@post
      }
      val job = Job(req.out, onProgress, onDone, onError)
      active = job
      try {
        start(app, req, job)
      } catch (e: Throwable) {
        try { job.transformer?.cancel() } catch (x: Throwable) { /* not started */ }
        finish(job, e)
      }
    }
  }

  /** Cancels the running export, if any; its pending call fails with editor:cancelled. */
  fun cancel() {
    handler.post {
      val job = active ?: return@post
      try { job.transformer?.cancel() } catch (e: Throwable) { /* already stopped */ }
      finish(job, EditorError("The export was cancelled.", "cancelled"))
    }
  }

  private fun start(context: Context, req: Request, job: Job) {
    val info = probe(context, req.source)

    val effects = mutableListOf<Effect>()
    req.crop?.let { c -> cropEffect(c, info.width, info.height)?.let { effects.add(it) } }

    val item = MediaItem.Builder()
      .setUri(req.source)
      .setClippingConfiguration(clipping(req.trimStart, req.trimEnd, info.durationMs))
      .build()

    val dir = req.out.parentFile ?: throw EditorError("The output has no parent folder: ${req.out.path}", "export_failed")
    if (!dir.isDirectory && !dir.mkdirs()) throw EditorError("Can't create folder ${dir.path}", "permission")
    if (dir.usableSpace < MIN_FREE_BYTES) throw EditorError("Not enough free space to export the video.", "no_space")
    if (req.out.exists() && !req.out.delete()) throw EditorError("Can't replace ${req.out.path}", "permission")

    val edited = EditedMediaItem.Builder(item)
      .setRemoveAudio(!req.audio)
      .setEffects(Effects(listOf<AudioProcessor>(), effects))
      .build()

    val transformer = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setLooper(thread.looper)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          finish(job, null)
        }

        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
          finish(job, mapError(exportException, job.out))
        }
      })
      .build()
    job.transformer = transformer
    transformer.start(edited, req.out.absolutePath)
    safely { job.onProgress(0.0) }
    handler.postDelayed({ poll(job) }, POLL_MS)
  }

  private fun poll(job: Job) {
    if (active !== job) return
    try {
      val t = job.transformer
      if (t != null) {
        val holder = ProgressHolder()
        if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          val f = holder.progress.coerceIn(0, 100) / 100.0
          if (f != job.lastFraction) {
            job.lastFraction = f
            safely { job.onProgress(f) }
          }
        }
      }
    } catch (e: Throwable) {
      // Progress is best effort; the listener still reports completion or failure.
    }
    handler.postDelayed({ poll(job) }, POLL_MS)
  }

  /** Settles [job] once; later calls (e.g. a listener firing after cancel) are ignored. */
  private fun finish(job: Job, error: Throwable?) {
    if (active !== job) return
    active = null
    job.transformer = null
    if (error == null && job.out.isFile && job.out.length() > 0L) {
      safely { job.onProgress(1.0) }
      safely { job.onDone(job.out) }
      return
    }
    job.out.delete()
    val e = error ?: EditorError("The export produced no file.", "export_failed")
    safely { job.onError(e) }
  }

  /** Display-pixel rect to a Media3 Crop in normalized device coordinates (y up). Null = full frame. */
  private fun cropEffect(c: CropRect, width: Int, height: Int): Crop? {
    if (width < MIN_SIDE || height < MIN_SIDE) throw EditorError("The video is too small to crop (${width}x$height).", "unsupported")
    val finite = c.x.isFinite() && c.y.isFinite() && c.w.isFinite() && c.h.isFinite()
    val inside = finite && c.x >= 0.0 && c.y >= 0.0 && c.w > 0.0 && c.h > 0.0 &&
      c.x + c.w <= width + 1.0 && c.y + c.h <= height + 1.0
    if (!inside) throw EditorError("The crop area is outside the video (${width}x$height).", "unsupported")
    val x = c.x.roundToInt().coerceIn(0, width - 2)
    val y = c.y.roundToInt().coerceIn(0, height - 2)
    var w = c.w.roundToInt().coerceIn(2, width - x)
    var h = c.h.roundToInt().coerceIn(2, height - y)
    // H.264 encoders want even dimensions.
    w -= w % 2
    h -= h % 2
    if (x == 0 && y == 0 && w >= width - 1 && h >= height - 1) return null
    val left = 2f * x / width - 1f
    val right = 2f * (x + w) / width - 1f
    val top = 1f - 2f * y / height
    val bottom = 1f - 2f * (y + h) / height
    return Crop(left, right, bottom, top)
  }

  private fun clipping(trimStart: Double?, trimEnd: Double?, durationMs: Long): MediaItem.ClippingConfiguration {
    for (v in listOfNotNull(trimStart, trimEnd)) {
      if (!v.isFinite() || v < 0.0) throw EditorError("Invalid trim time: $v", "unsupported")
    }
    val start = trimStart?.let { (it * 1000.0).roundToLong() } ?: 0L
    val end = trimEnd?.let { (it * 1000.0).roundToLong() }
    if (durationMs > 0L && start >= durationMs) throw EditorError("The trim start is past the end of the video.", "unsupported")
    if (end != null && end < start + MIN_CLIP_MS) throw EditorError("The trimmed clip is too short.", "unsupported")
    val b = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(start)
    if (end != null && (durationMs <= 0L || end < durationMs)) b.setEndPositionMs(end)
    return b.build()
  }

  private fun mapError(e: ExportException, out: File): EditorError {
    val freeLow = (out.parentFile?.usableSpace ?: Long.MAX_VALUE) < MIN_FREE_BYTES
    val code = when {
      freeLow || isNoSpace(e) -> "no_space"
      e.errorCode == ExportException.ERROR_CODE_IO_NO_PERMISSION -> "permission"
      e.errorCode == ExportException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ||
        e.errorCode == ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED -> "unsupported"
      else -> "export_failed"
    }
    val detail = e.cause?.message
    val msg = (e.message ?: "Export failed") + " (code ${e.errorCode})" + (if (detail != null) ": $detail" else "")
    return EditorError(msg, code)
  }

  private fun isNoSpace(e: Throwable): Boolean {
    var t: Throwable? = e
    var depth = 0
    while (t != null && depth < 12) {
      if (t is ErrnoException && t.errno == OsConstants.ENOSPC) return true
      val m = t.message ?: ""
      if (m.contains("ENOSPC") || m.contains("No space left", ignoreCase = true)) return true
      t = t.cause
      depth++
    }
    return false
  }

  private inline fun safely(block: () -> Unit) {
    try {
      block()
    } catch (e: Throwable) {
      // A failing callback must not kill the editor thread.
    }
  }
}
