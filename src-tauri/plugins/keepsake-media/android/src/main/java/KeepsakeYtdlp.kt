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
 * Bridge to keepsake_ytdlp.py (Chaquopy). Every call is blocking and must run on [executor],
 * a single thread: Python starts there (first start extracts the stdlib) and jobs run one at a time.
 */
internal object KeepsakeYtdlp {
  val CODES = setOf(
    "unsupported_url", "login_required", "rate_limited", "forbidden",
    "not_found", "parse_failed", "network", "unknown",
  )

  val executor: ExecutorService = Executors.newSingleThreadExecutor()

  private fun module(context: Context): PyObject {
    if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
    return Python.getInstance().getModule("keepsake_ytdlp")
  }

  /** Returns {"ok":true,"info":{...}} or throws [YtdlpError]. */
  fun info(context: Context, url: String): JSONObject =
    parse(module(context).callAttr("info", url).toString())

  /** Returns {"ok":true,"path":...,"bytes":...} or throws [YtdlpError]. A null [fileName] becomes Python None. */
  fun download(context: Context, url: String, formatId: String, outDir: String, fileName: String?): JSONObject =
    parse(module(context).callAttr("download", url, formatId, outDir, fileName).toString())

  private fun parse(json: String): JSONObject {
    val r = JSONObject(json)
    if (!r.optBoolean("ok", false)) {
      val code = r.optString("code", "unknown")
      throw YtdlpError(if (code in CODES) code else "unknown", r.optString("message", "yt-dlp failed."))
    }
    return r
  }
}
