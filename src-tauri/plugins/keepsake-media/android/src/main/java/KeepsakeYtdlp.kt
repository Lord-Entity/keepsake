package app.keepsake.media

import android.content.Context
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

/** A yt-dlp failure: [code] is one of [KeepsakeYtdlp.CODES]. */
internal class YtdlpError(val code: String, message: String) : Exception(message)

/**
 * Bridge to keepsake_ytdlp.py (Chaquopy). Every call is blocking. Run [info] on [infoExecutor]
 * (never blocked by downloads) and [download] / mux on [executor] (2 threads).
 */
internal object KeepsakeYtdlp {
  val CODES = setOf(
    "unsupported_url", "login_required", "rate_limited", "forbidden", "not_found",
    "parse_failed", "network", "timeout", "no_space", "permission", "too_large",
    "cancelled", "format_unavailable", "mux_failed", "empty", "unknown",
  )

  /** Downloads and muxing. */
  val executor: ExecutorService = Executors.newFixedThreadPool(2)

  /** Metadata lookups only. */
  val infoExecutor: ExecutorService = Executors.newSingleThreadExecutor()

  @Synchronized
  private fun module(context: Context): PyObject {
    if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
    return Python.getInstance().getModule("keepsake_ytdlp")
  }

  /** Returns {"ok":true,"info":{...}} or throws [YtdlpError]. */
  fun info(context: Context, url: String): JSONObject =
    parse(module(context).callAttr("info", url).toString())

  /** Returns {"ok":true,"path":...,"bytes":...} or throws [YtdlpError]. A null [fileName] becomes Python None. */
  fun download(
    context: Context, url: String, formatId: String, outDir: String, fileName: String?, jobId: String,
  ): JSONObject =
    parse(module(context).callAttr("download", url, formatId, outDir, fileName, jobId).toString())

  /** Sets the cancel flag of [jobId]; the running download stops at its next progress tick. */
  fun cancel(context: Context, jobId: String) {
    module(context).callAttr("cancel", jobId)
  }

  /** Muxes one video-only and one audio-only file into an MP4. Throws [YtdlpError]. */
  fun mux(context: Context, video: java.io.File, audio: java.io.File, outDir: java.io.File, fileName: String): JSONObject =
    try {
      KeepsakeMux.mux(context, video, audio, outDir, fileName)
    } catch (e: MediaError) {
      throw YtdlpError(if (e.code in CODES) e.code else "unknown", e.message ?: "Mux failed.")
    }

  private fun parse(json: String): JSONObject {
    val r = JSONObject(json)
    if (!r.optBoolean("ok", false)) {
      val code = r.optString("code", "unknown")
      throw YtdlpError(if (code in CODES) code else "unknown", r.optString("message", "yt-dlp failed."))
    }
    return r
  }
}
