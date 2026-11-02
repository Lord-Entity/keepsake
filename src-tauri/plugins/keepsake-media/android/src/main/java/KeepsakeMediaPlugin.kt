package app.keepsake.media

import android.app.Activity
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Environment
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
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

private class MediaError(message: String) : Exception(message)

/**
 * Audio conversion on platform codecs only (android.media.*):
 * - m4a: copy the file when it is already an audio-only MP4, otherwise remux the AAC
 *   track into a new MP4 with MediaMuxer. No re-encoding.
 * - wav: decode the first audio track with MediaCodec to 16-bit PCM and write RIFF/WAVE.
 * Everything streams buffer by buffer; the file is never held in memory.
 */
@TauriPlugin
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
    for (type in arrayOf(Environment.DIRECTORY_DOWNLOADS, Environment.DIRECTORY_MUSIC, Environment.DIRECTORY_MOVIES)) {
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
  }
}
