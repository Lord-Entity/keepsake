package app.keepsake.media

import android.content.Context
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** A yt-dlp failure: [code] is one of [KeepsakeYtdlp.CODES]. */
internal class YtdlpError(val code: String, message: String) : Exception(message)

/**
 * Bridge to keepsake_ytdlp.py (Chaquopy). Every call is blocking. Run [info] / [status] on [infoExecutor]
 * (never blocked by downloads) and [download] / mux on [executor] (2 threads).
 */
internal object KeepsakeYtdlp {
  val CODES = setOf(
    "unsupported_url", "login_required", "rate_limited", "forbidden", "not_found",
    "parse_failed", "network", "timeout", "no_space", "permission", "too_large",
    "cancelled", "format_unavailable", "mux_failed", "empty", "unknown",
    "js_runtime_missing", "ytdlp_missing", "bot_check",
  )

  /** Downloads and muxing. */
  val executor: ExecutorService = Executors.newFixedThreadPool(2)

  /** Metadata lookups and status only. */
  val infoExecutor: ExecutorService = Executors.newSingleThreadExecutor()

  /** Set once keepsake_ytdlp.configure has run in this process. Guarded by [module]'s lock. */
  @Volatile
  private var configured = false

  @Synchronized
  private fun module(context: Context): PyObject {
    if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
    val m = Python.getInstance().getModule("keepsake_ytdlp")
    if (!configured) {
      // Bundled executables (libqjs.so, libffmpeg.so) can only be exec'd from nativeLibraryDir.
      // configure() never raises; it only enables what it finds executable.
      val app = context.applicationContext
      m.callAttr("configure", app.applicationInfo.nativeLibraryDir, File(app.cacheDir, "ytdlp").path)
      configured = true
    }
    return m
  }

  /**
   * Returns the self-check JSON {ok, ytdlp, ejs, jsRuntime, ffmpeg, ready, problems}; problems are data.
   * Throws [YtdlpError] only when status() itself failed ({"ok": false, "code", "message"}).
   */
  fun status(context: Context): JSONObject =
    parse(module(context).callAttr("status").toString())

  /** Returns {"ok":true,"info":{...}} or throws [YtdlpError]. [full] enables the bundled JS runtime / ffmpeg route. */
  fun info(context: Context, url: String, full: Boolean = false): JSONObject =
    parse(module(context).callAttr("info", url, full).toString())

  /**
   * Returns {"ok":true,"path":...,"bytes":...} or throws [YtdlpError]. Exactly one of [formatId] / [args] is set.
   * [args] goes to Python as ONE JSON string (a Java list would arrive as a Java object, not a Python list).
   * A null [fileName] / [formatId] becomes Python None.
   */
  fun download(
    context: Context,
    url: String,
    formatId: String?,
    outDir: String,
    fileName: String?,
    jobId: String,
    args: List<String>? = null,
    full: Boolean = false,
  ): JSONObject {
    val argsJson: String? = args?.let { JSONArray(it).toString() }
    return parse(
      module(context).callAttr("download", url, formatId, outDir, fileName, jobId, argsJson, full).toString(),
    )
  }

  /** Sets the cancel flag of [jobId]; the running download stops at its next progress tick. */
  fun cancel(context: Context, jobId: String) {
    module(context).callAttr("cancel", jobId)
  }

  /** Muxes one video-only and one audio-only file into MP4 or WebM (chosen from the codecs). Throws [YtdlpError]. */
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
