package app.keepsake.media

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Storage Access Framework helpers for the user-chosen save folder (a persisted tree URI).
 * Errors are [MediaError] with codes: permission, not_found, no_space, source_missing, bad_uri, io.
 * Uses platform APIs only (no androidx.documentfile).
 */
internal object KeepsakeSaf {
  private const val MAX_URI = 2048
  private const val BUF = 64 * 1024

  private fun parse(raw: String): Uri {
    if (raw.isEmpty() || raw.length > MAX_URI || raw.any { it == '\u0000' || it.isWhitespace() }) {
      throw MediaError("Invalid folder address.", "bad_uri")
    }
    val uri = try { Uri.parse(raw) } catch (e: Exception) { throw MediaError("Invalid folder address.", "bad_uri") }
    if (uri.scheme != "content" || uri.authority.isNullOrEmpty()) {
      throw MediaError("The folder address must be a content:// URI.", "bad_uri")
    }
    return uri
  }

  private fun treeId(uri: Uri): String? =
    try { DocumentsContract.getTreeDocumentId(uri) } catch (e: Exception) { null }

  private fun sameTree(a: Uri, b: Uri): Boolean {
    if (a.authority != b.authority) return false
    val ia = treeId(a) ?: return false
    return ia == treeId(b)
  }

  /** Persisted grants for tree URIs that include write access. */
  private fun writeGrants(context: Context): List<Uri> =
    context.contentResolver.persistedUriPermissions
      .filter { it.isReadPermission && it.isWritePermission }
      .map { it.uri }

  /** Take a persistable READ|WRITE grant on [uri] and release every other tree grant. */
  fun persistTree(context: Context, uri: Uri) {
    val resolver = context.contentResolver
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    try {
      resolver.takePersistableUriPermission(uri, flags)
    } catch (e: SecurityException) {
      throw MediaError("Couldn't keep access to that folder: ${e.message ?: "permission denied"}", "permission")
    }
    for (p in resolver.persistedUriPermissions) {
      val other = p.uri
      if (other == uri || sameTree(other, uri) || treeId(other) == null) continue
      try {
        resolver.releasePersistableUriPermission(other, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      } catch (ignored: Exception) {
        // best effort
      }
    }
  }

  fun hasWriteGrant(context: Context, treeUri: Uri): Boolean =
    writeGrants(context).any { it == treeUri || sameTree(it, treeUri) }

  /** Display name of the tree root, or null if it can't be read. */
  fun treeName(context: Context, treeUri: Uri): String? {
    return try {
      val id = DocumentsContract.getTreeDocumentId(treeUri)
      val root = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
      queryName(context, root)
    } catch (e: Exception) {
      null
    }
  }

  private fun queryName(context: Context, docUri: Uri): String? =
    try {
      context.contentResolver.query(
        docUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
      )?.use { c ->
        if (c.moveToFirst()) c.getString(0)
        else null
      }
    } catch (e: Exception) {
      null
    }

  /** Parse and require a content:// tree URI that has a persisted read+write grant. */
  fun checkedTreeUri(context: Context, raw: String): Uri {
    val uri = parse(raw)
    if (treeId(uri) == null) throw MediaError("That address is not a folder.", "bad_uri")
    if (!hasWriteGrant(context, uri)) {
      throw MediaError("Keepsake no longer has access to the chosen folder. Choose it again.", "permission")
    }
    return uri
  }

  /** Parse and require a content:// document URI inside a persisted tree grant (same authority and tree id). */
  fun checkedDocUri(context: Context, raw: String): Uri {
    val uri = parse(raw)
    val id = treeId(uri) ?: throw MediaError("That address is not inside a chosen folder.", "bad_uri")
    val granted = writeGrants(context).any { it.authority == uri.authority && treeId(it) == id }
    if (!granted) throw MediaError("Keepsake has no access to that file's folder.", "permission")
    return uri
  }

  /** Copy [src] into a new document in the tree. Returns {uri, name, bytes}. Deletes only the half-written document on error. */
  fun copyToTree(context: Context, src: File, treeUri: Uri, fileName: String, mime: String): JSONObject {
    if (!src.isFile) throw MediaError("The downloaded file is missing: ${src.name}", "source_missing")
    val clean = fileName.replace('/', '_').replace('\\', '_').trim()
    if (clean.isEmpty() || clean == "." || clean == "..") throw MediaError("Invalid file name.", "io")
    val resolver = context.contentResolver
    val parent = try {
      DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
    } catch (e: Exception) {
      throw MediaError("Invalid folder address.", "bad_uri")
    }
    if (!hasWriteGrant(context, treeUri)) {
      throw MediaError("Keepsake no longer has access to the chosen folder. Choose it again.", "permission")
    }
    var doc: Uri? = null
    try {
      doc = try {
        DocumentsContract.createDocument(resolver, parent, mime.ifBlank { "application/octet-stream" }, clean)
      } catch (e: SecurityException) {
        throw MediaError("No permission to write in the chosen folder.", "permission")
      } catch (e: IllegalArgumentException) {
        throw MediaError("The chosen folder no longer exists.", "not_found")
      } catch (e: java.io.FileNotFoundException) {
        throw MediaError("The chosen folder no longer exists.", "not_found")
      }
      if (doc == null) throw MediaError("Couldn't create the file in the chosen folder.", "io")
      var total = 0L
      val out = resolver.openOutputStream(doc, "w")
        ?: throw MediaError("Couldn't open the new file for writing.", "io")
      out.use { os ->
        FileInputStream(src).use { input ->
          val buf = ByteArray(BUF)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            os.write(buf, 0, n)
            total += n
          }
          os.flush()
        }
      }
      val name = queryName(context, doc) ?: clean
      return JSONObject().put("uri", doc.toString()).put("name", name).put("bytes", total)
    } catch (e: Exception) {
      doc?.let {
        try { DocumentsContract.deleteDocument(resolver, it) } catch (ignored: Exception) {}
      }
      if (e is MediaError) throw e
      if (e is SecurityException) throw MediaError("No permission to write in the chosen folder.", "permission")
      if (e is java.io.FileNotFoundException && !src.isFile) throw MediaError("The downloaded file is missing: ${src.name}", "source_missing")
      if (e is IOException) {
        val m = e.message ?: ""
        if (m.contains("ENOSPC") || m.contains("No space", ignoreCase = true)) {
          throw MediaError("Not enough free space in the chosen folder.", "no_space")
        }
        throw MediaError("Couldn't save to the chosen folder: ${m.ifEmpty { e.javaClass.simpleName }}", "io")
      }
      throw MediaError("Couldn't save to the chosen folder: ${e.message ?: e.javaClass.simpleName}", "io")
    }
  }
}
