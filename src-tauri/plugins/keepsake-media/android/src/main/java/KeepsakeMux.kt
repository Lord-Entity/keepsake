package app.keepsake.media

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import org.json.JSONObject

/**
 * Combines a video-only and an audio-only file without re-encoding. The container (MP4 or WebM)
 * is chosen from the actual track codecs.
 */
internal object KeepsakeMux {
  private const val BUFFER_SIZE = 2 * 1024 * 1024

  // MediaFormat has no VP8/VP9/Vorbis/Opus constants on every supported API level, and
  // MIMETYPE_VIDEO_AV1 only exists since API 29. These are the literal MIME strings.
  private const val MIME_VP8 = "video/x-vnd.on2.vp8"
  private const val MIME_VP9 = "video/x-vnd.on2.vp9"
  private const val MIME_AV1 = "video/av01"
  private const val MIME_VORBIS = "audio/vorbis"
  private const val MIME_OPUS = "audio/opus"

  /** Extensions stripped from [mux]'s incoming file name before the container's own is appended. */
  private val STRIP_EXTS = arrayOf(".mp4", ".webm", ".mkv", ".m4a", ".mov")

  private class Container(val format: Int, val ext: String)

  /** Returns {"path","bytes","ext"}. Throws [MediaError] with a ytdlp code (mux_failed, empty, no_space, ...). */
  fun mux(context: Context, video: File, audio: File, outDir: File, fileName: String): JSONObject {
    var part: File? = null
    try {
      if (!video.isFile) throw MediaError("Video file not found.", "mux_failed")
      if (!audio.isFile) throw MediaError("Audio file not found.", "mux_failed")
      val container = chooseContainer(video, audio)

      val clean = fileName.substringAfterLast('/').substringAfterLast('\\').trim()
      if (clean.isEmpty() || clean == "." || clean == ".." || clean.startsWith(".")) {
        throw MediaError("Invalid output name.", "mux_failed")
      }
      val base = STRIP_EXTS.firstOrNull { clean.endsWith(it, ignoreCase = true) }
        ?.let { clean.dropLast(it.length) }
        ?: clean
      if (base.isEmpty() || base == "." || base == ".." || base.startsWith(".")) {
        throw MediaError("Invalid output name.", "mux_failed")
      }
      val name = base + container.ext
      if (!outDir.isDirectory && !outDir.mkdirs()) throw MediaError("Can't create folder ${outDir.path}", "permission")
      val out = File(outDir, name)
      val tmp = File(outDir, "$name.part")
      part = tmp
      tmp.delete()

      muxFiles(video, audio, tmp, container.format)
      if (!tmp.isFile || tmp.length() <= 0L) throw MediaError("The muxed file is empty.", "empty")

      if (out.exists() && !out.delete()) throw MediaError("Can't replace ${out.path}", "permission")
      if (!tmp.renameTo(out)) throw MediaError("Can't move the muxed file to ${out.path}", "permission")
      part = null

      val cache = context.cacheDir.canonicalFile
      for (f in arrayOf(video, audio)) {
        try {
          val c = f.canonicalFile
          if (c.path.startsWith(cache.path + File.separator)) c.delete()
        } catch (ignored: Exception) {
        }
      }
      return JSONObject().put("path", out.absolutePath).put("bytes", out.length()).put("ext", container.ext.removePrefix("."))
    } catch (e: MediaError) {
      part?.delete()
      throw e
    } catch (e: java.io.IOException) {
      part?.delete()
      val code = if (e.message?.contains("ENOSPC") == true || e.message?.contains("No space") == true) "no_space" else "mux_failed"
      throw MediaError(e.message ?: "Mux failed.", code)
    } catch (e: Exception) {
      part?.delete()
      throw MediaError("Couldn't combine video and audio: ${e.message ?: e.javaClass.simpleName}", "mux_failed")
    }
  }

  /** Picks the only container that can hold these codecs without re-encoding. */
  private fun chooseContainer(video: File, audio: File): Container {
    val vm = probeMime(video, "video")
    val am = probeMime(audio, "audio")

    val aac = am == MediaFormat.MIMETYPE_AUDIO_AAC
    val opus = am == MIME_OPUS

    if (vm == MediaFormat.MIMETYPE_VIDEO_AVC || vm == MediaFormat.MIMETYPE_VIDEO_HEVC) {
      if (aac) return Container(MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4, ".mp4")
    }
    if (vm == MIME_VP8 || vm == MIME_VP9) {
      if (am == MIME_VORBIS || opus) return Container(MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM, ".webm")
    }
    if (vm == MIME_AV1) {
      if (aac || opus) {
        // AV1 in MP4 needs Android 10 (API 29); MediaMuxer writes it as av01 in MP4 from there.
        if (android.os.Build.VERSION.SDK_INT >= 29) {
          return Container(MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4, ".mp4")
        }
        throw MediaError("Can't combine AV1 into a file on this Android version.", "mux_failed")
      }
    }
    throw MediaError(
      "Can't combine $vm video with $am audio into MP4 or WebM without re-encoding.",
      "mux_failed",
    )
  }

  /** Returns the MIME type of the first track whose type starts with [trackKind] + "/". */
  private fun probeMime(file: File, trackKind: String): String {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(file.absolutePath)
      val index = firstTrack(ex, "$trackKind/")
      if (index < 0) throw MediaError("The $trackKind file has no $trackKind track.", "mux_failed")
      return ex.getTrackFormat(index).getString(MediaFormat.KEY_MIME)
        ?: throw MediaError("The $trackKind track has no codec.", "mux_failed")
    } finally {
      ex.release()
    }
  }

  private fun firstTrack(ex: MediaExtractor, prefix: String): Int {
    for (i in 0 until ex.trackCount) {
      val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith(prefix)) return i
    }
    return -1
  }

  private fun muxFiles(video: File, audio: File, out: File, outputFormat: Int) {
    val vx = MediaExtractor()
    val ax = MediaExtractor()
    var muxer: MediaMuxer? = null
    var started = false
    try {
      vx.setDataSource(video.absolutePath)
      ax.setDataSource(audio.absolutePath)
      val vt = firstTrack(vx, "video/")
      val at = firstTrack(ax, "audio/")
      if (vt < 0) throw MediaError("The video file has no video track.", "mux_failed")
      if (at < 0) throw MediaError("The audio file has no audio track.", "mux_failed")
      val vf = vx.getTrackFormat(vt)
      val af = ax.getTrackFormat(at)
      val vm = vf.getString(MediaFormat.KEY_MIME)
      val am = af.getString(MediaFormat.KEY_MIME)
      if (vm == null || am == null) throw MediaError("An input track has no codec.", "mux_failed")

      val m = MediaMuxer(out.absolutePath, outputFormat)
      muxer = m
      if (vf.containsKey(MediaFormat.KEY_ROTATION)) m.setOrientationHint(vf.getInteger(MediaFormat.KEY_ROTATION))
      val vDst = m.addTrack(vf)
      val aDst = m.addTrack(af)
      vx.selectTrack(vt)
      ax.selectTrack(at)
      m.start()
      started = true

      val buf = ByteBuffer.allocateDirect(
        maxOf(
          BUFFER_SIZE,
          if (vf.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) vf.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0,
          if (af.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) af.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0,
        ),
      )
      val info = MediaCodec.BufferInfo()
      var vSamples = 0
      var aSamples = 0
      while (true) {
        val vTime = vx.sampleTime // -1 at end
        val aTime = ax.sampleTime
        if (vTime < 0 && aTime < 0) break
        val useVideo = vTime >= 0 && (aTime < 0 || vTime <= aTime)
        val ex = if (useVideo) vx else ax
        buf.clear()
        val n = ex.readSampleData(buf, 0)
        if (n < 0) {
          // Treat as end of this track by advancing past it.
          if (!ex.advance()) {
            if (useVideo) { if (aTime < 0) break } else { if (vTime < 0) break }
          }
          continue
        }
        val flags = if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        info.set(0, n, ex.sampleTime, flags)
        m.writeSampleData(if (useVideo) vDst else aDst, buf, info)
        if (useVideo) vSamples++ else aSamples++
        ex.advance()
      }
      if (vSamples == 0 || aSamples == 0) throw MediaError("An input had no samples to copy.", "empty")
      m.stop()
      started = false
    } finally {
      try { if (started) muxer?.stop() } catch (ignored: Exception) { }
      try { muxer?.release() } catch (ignored: Exception) { }
      vx.release()
      ax.release()
    }
  }
}
