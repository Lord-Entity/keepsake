package app.keepsake.media

import android.content.ContentUris
import android.content.ContentValues
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Publishes finished downloads into the shared Gallery (MediaStore).
 * Blocking; call from a worker thread. Throws [MediaError] with code
 * "no_space", "permission" or "unknown". Deletes [src] only after success.
 */
internal object KeepsakeGallery {
    private const val SPACE_MARGIN = 8L * 1024 * 1024
    private const val BUF = 64 * 1024

    /**
     * @param kind "video", "audio" or "image"; only used when [mime] is not one of those families.
     * @return {uri, displayPath, bytes}
     */
    fun publish(context: Context, src: File, kind: String, fileName: String, mime: String): JSONObject {
        try {
            if (!src.isFile) throw MediaError("Source file is missing.", "unknown")
            val family = familyOf(mime, kind)
            val folder = when (family) {
                "video" -> Environment.DIRECTORY_MOVIES
                "audio" -> Environment.DIRECTORY_MUSIC
                "image" -> Environment.DIRECTORY_PICTURES
                else -> throw MediaError("Unsupported media type.", "unknown")
            }
            checkSpace(src.length())
            val safeMime = mimeForFamily(mime, family, fileName)
            val out = if (Build.VERSION.SDK_INT >= 29) {
                publishQ(context, src, family, folder, fileName, safeMime)
            } else {
                publishLegacy(context, src, folder, fileName, safeMime)
            }
            src.delete()
            return out
        } catch (e: MediaError) {
            throw e
        } catch (e: Throwable) {
            throw mapError(e)
        }
    }

    /** Moves [src] into the app's external Downloads folder. Returns the new file, or null on failure. */
    fun keepForRecovery(context: Context, src: File): File? {
        return try {
            if (!src.isFile) return null
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
            dir.mkdirs()
            val dest = uniqueFile(dir, src.name)
            if (src.renameTo(dest)) return dest
            try {
                FileInputStream(src).use { i -> FileOutputStream(dest).use { o -> i.copyTo(o, BUF) } }
            } catch (e: Throwable) {
                dest.delete() // never leave a partial copy behind; the source is still intact
                throw e
            }
            src.delete()
            dest
        } catch (ignored: Throwable) {
            null
        }
    }

    private fun familyOf(mime: String, kind: String): String {
        val m = mime.lowercase()
        return when {
            m.startsWith("video/") -> "video"
            m.startsWith("audio/") -> "audio"
            m.startsWith("image/") -> "image"
            else -> kind.lowercase()
        }
    }

    private fun checkSpace(needed: Long) {
        val free = try {
            StatFs(Environment.getExternalStorageDirectory().path).availableBytes
        } catch (ignored: Throwable) {
            return
        }
        if (free < needed + SPACE_MARGIN) throw MediaError("Not enough storage space.", "no_space")
    }

    private fun mapError(e: Throwable): MediaError {
        val msg = e.message ?: e.javaClass.simpleName
        return when {
            e is SecurityException -> MediaError(msg, "permission")
            e is IOException && (msg.contains("ENOSPC") || msg.contains("No space", true)) ->
                MediaError(msg, "no_space")
            else -> MediaError(msg, "unknown")
        }
    }

    private fun collectionFor(family: String): Uri = when (family) {
        "video" -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        "audio" -> MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }

    private fun publishQ(
        context: Context, src: File, family: String, folder: String, fileName: String, mime: String,
    ): JSONObject {
        val resolver = context.contentResolver
        val rel = "$folder/Keepsake"
        val now = System.currentTimeMillis() / 1000
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, rel)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
            put(MediaStore.MediaColumns.DATE_ADDED, now)
            put(MediaStore.MediaColumns.DATE_MODIFIED, now)
        }
        val uri = resolver.insert(collectionFor(family), values)
            ?: throw MediaError("Could not create Gallery entry.", "unknown")
        try {
            val os = resolver.openOutputStream(uri, "w")
                ?: throw MediaError("Could not open Gallery entry.", "unknown")
            os.use { o ->
                FileInputStream(src).use { it.copyTo(o, BUF) }
                o.flush()
            }
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            // A row left pending is hidden from the Gallery and purged later: treat it as a failure.
            if (resolver.update(uri, done, null, null) < 1) {
                throw MediaError("Could not finish the Gallery entry.", "unknown")
            }
            var actual = fileName
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.let { actual = it }
            }
            return JSONObject().apply {
                put("uri", uri.toString())
                put("displayPath", "$rel/$actual")
                put("bytes", src.length())
            }
        } catch (e: Throwable) {
            try { resolver.delete(uri, null, null) } catch (ignored: Throwable) {}
            throw if (e is MediaError) e else mapError(e)
        }
    }

    @Suppress("DEPRECATION")
    private fun publishLegacy(
        context: Context, src: File, folder: String, fileName: String, mime: String,
    ): JSONObject {
        val dir = File(Environment.getExternalStoragePublicDirectory(folder), "Keepsake")
        if (!dir.isDirectory && !dir.mkdirs()) throw MediaError("Could not create ${dir.path}.", "permission")
        val dest = uniqueFile(dir, fileName)
        val part = File(dir, dest.name + ".part")
        try {
            FileInputStream(src).use { i -> FileOutputStream(part).use { o -> i.copyTo(o, BUF); o.flush() } }
            if (!part.renameTo(dest)) throw MediaError("Could not finalise file.", "unknown")
        } catch (e: Throwable) {
            part.delete()
            dest.delete()
            throw if (e is MediaError) e else mapError(e)
        }
        val latch = CountDownLatch(1)
        var scanned: Uri? = null
        MediaScannerConnection.scanFile(context, arrayOf(dest.absolutePath), arrayOf(mime)) { _, u ->
            scanned = u
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        // API 24-28: never hand back file:// (Rust open_file rejects it; other apps can't read it).
        // Order: scanner's content://media URI, then a MediaStore lookup by path, then our
        // FileProvider content:// URI (openFile accepts that authority; keepsake_paths covers
        // Movies/Music), and as a last resort the absolute path, which Rust accepts and
        // openFile shares through FileProvider exactly like a TikTok/Instagram file.
        val uriStr = scanned?.takeIf { it.scheme == "content" }?.toString()
            ?: legacyMediaUri(context, dest)?.toString()
            ?: try {
                FileProvider.getUriForFile(
                    context, "${context.packageName}.keepsake.fileprovider", dest,
                ).toString()
            } catch (ignored: Exception) {
                dest.absolutePath
            }
        return JSONObject().apply {
            put("uri", uriStr)
            put("displayPath", dest.absolutePath)
            put("bytes", dest.length())
        }
    }

    /** API 24-28: finds the MediaStore row for [file] by its DATA path, or null. */
    @Suppress("DEPRECATION")
    private fun legacyMediaUri(context: Context, file: File): Uri? = try {
        val files = MediaStore.Files.getContentUri("external")
        context.contentResolver.query(
            files, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DATA}=?", arrayOf(file.absolutePath), null,
        )?.use { c -> if (c.moveToFirst()) ContentUris.withAppendedId(files, c.getLong(0)) else null }
    } catch (ignored: Throwable) {
        null
    }

    /** Collections reject a MIME outside their family (e.g. application/octet-stream for .mkv). */
    private fun mimeForFamily(mime: String, family: String, fileName: String): String {
        if (mime.lowercase().startsWith("$family/")) return mime
        val ext = fileName.substringAfterLast('.', "").lowercase()
        val guess = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        if (guess != null && guess.startsWith("$family/")) return guess
        return when (family) {
            "video" -> "video/mp4"
            "audio" -> "audio/mpeg"
            else -> "image/jpeg"
        }
    }

    private fun uniqueFile(dir: File, name: String): File {
        var f = File(dir, name)
        if (!f.exists()) return f
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var n = 1
        while (f.exists()) {
            f = File(dir, "$base ($n)$ext")
            n++
        }
        return f
    }
}
